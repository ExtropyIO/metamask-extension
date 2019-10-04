const ObservableStore = require('obs-store')
const EventEmitter = require('safe-event-emitter')
const extend = require('xtend')

const isTest = process.env.IN_TEST === 'true' || process.env.METAMASK_ENV === 'test'
const SES = (
  isTest
    ? {
      makeSESRootRealm: () => {
        return {
          evaluate: () => {
            return () => true
          },
        }
      },
    }
    : require('ses')
)

/*
 * A plugin is initialized in three phases:
 * - Add: Loads the plugin from a remote source and parses it.
 * - Authorize: Requests the plugin's required permissions from the user.
 * - Start: Initializes the plugin in its SES realm with the authorized permissions.
 */

class PluginsController extends EventEmitter {

  constructor (opts = {}) {
    super()
    const initState = extend({
      plugins: {},
      pluginStates: {},
    }, opts.initState)
    this.store = new ObservableStore(initState)

    // TODO:SECURITY disable errorStackMode for production
    this.rootRealm = SES.makeSESRootRealm({consoleMode: 'allow', errorStackMode: 'allow', mathRandomMode: 'allow'})

    this.setupProvider = opts.setupProvider
    this._txController = opts._txController
    this._networkController = opts._networkController
    this._blockTracker = opts._blockTracker
    this._getAccounts = opts._getAccounts
    this.getApi = opts.getApi
    this.getAppKeyForDomain = opts.getAppKeyForDomain

    this.rpcMessageHandlers = new Map()
    this.adding = {}
  }

  runExistingPlugins () {
    const plugins = this.store.getState().plugins
    console.log('running existing plugins')
    Object.values(plugins).forEach(({ pluginName, approvedPermissions, sourceCode }) => {
      console.log(`running: ${pluginName}`)
      const ethereumProvider = this.setupProvider(pluginName, async () => { return {name: pluginName } }, true)
      try {
        this._startPlugin(pluginName, approvedPermissions, sourceCode, ethereumProvider)
      } catch (err) {
        console.warn(`failed to start '${pluginName}', deleting it`)
        // Clean up failed plugins:
        this.deletePlugin(pluginName)
      }
    })
  }

  get (pluginName) {
    return this.store.getState().plugins[pluginName]
  }

  // When a plugin is first created, where should it be executed?
  // And how do we ensure that the same plugin is never executed twice?

  updatePluginState (pluginName, newPluginState) {
    const state = this.store.getState()

    const newPluginStates = { ...state.pluginStates, [pluginName]: newPluginState }

    this.store.updateState({
      ...state,
      pluginStates: newPluginStates,
    })
  }

  getPluginState (pluginName) {
    return this.store.getState().pluginStates[pluginName]
  }

  clearPluginState () {
    this.rpcMessageHandlers.clear()
    this.store.updateState({
      plugins: {},
      pluginStates: {},
    })
    alert('Plugin state cleared.')
  }

  deletePlugin (pluginName) {
    const state = this.store.getState()

    const newPlugins = { ...state.plugins }
    delete newPlugins[pluginName]

    this.store.updateState({
      ...state,
      plugins: newPlugins,
    })
  }

  /**
   * Returns a promise representing the complete installation of the requested plugin.
   * If the plugin is already being installed, the previously pending promise will be returned.
   */
  add (pluginName, sourceUrl) {
    if (!sourceUrl) {
      sourceUrl = pluginName
    }

    // Deduplicate multiple add requests:
    if (!(pluginName in this.adding)) {
      this.adding[pluginName] = this._add(pluginName)
    }

    return this.adding[pluginName]
  }

  async _add (pluginName, sourceUrl) {
    if (!sourceUrl) {
      sourceUrl = pluginName
    }
    const pluginState = this.store.getState().plugins

    if (!pluginName || typeof pluginName !== 'string') {
      throw new Error(`Invalid plugin name: ${pluginName}`)
    }

    let plugin
    try {
      const pluginSource = await fetch(sourceUrl)
      const pluginJson = await pluginSource.json()
      const { web3Wallet: { bundle, initialPermissions } } = pluginJson
      const pluginBundle = await fetch(bundle.url)
      const sourceCode = await pluginBundle.text()
      plugin = {
        sourceCode,
        initialPermissions,
      }
    } catch (err) {
      throw new Error(`Problem loading plugin ${pluginName}: ${err.message}`)
    }

    // restore relevant plugin state if it exists
    if (pluginState[pluginName]) {
      plugin = { ...pluginState[pluginName], ...plugin }
    }
    plugin.pluginName = pluginName

    // store the plugin back in state
    this.store.updateState({
      plugins: {
        ...pluginState,
        [pluginName]: plugin,
      },
    })
  }

  async authorize (pluginName) {
    const pluginState = this.store.getState().plugins
    const plugin = pluginState[pluginName]
    const { sourceCode, initialPermissions } = plugin
    const ethereumProvider = this.setupProvider(pluginName, async () => { return {name: pluginName } }, true)

    return new Promise((resolve, reject) => {

      // Don't prompt if there are no permissions requested:
      if (Object.keys(initialPermissions).length === 0) {
        plugin.approvedPermissions = []
        return resolve(plugin)
      }

      ethereumProvider.sendAsync({
        method: 'wallet_requestPermissions',
        jsonrpc: '2.0',
        params: [ initialPermissions, { sourceCode, ethereumProvider }],
      }, (err1, res1) => {
        if (err1) reject(err1)

        const approvedPermissions = res1.result.map(perm => perm.parentCapability)

        // the stored initial permissions are the permissions approved
        // by the user
        plugin.approvedPermissions = approvedPermissions

        this.store.updateState({
          plugins: {
            ...pluginState,
            [pluginName]: plugin,
          },
        })

        resolve(plugin)
      })
    })
      .finally(() => {
        delete this.adding[pluginName]
      })
  }

  async run (pluginName, approvedPermissions, sourceCode, ethereumProvider) {
    return this._startPlugin(pluginName, approvedPermissions, sourceCode, ethereumProvider)
  }

  _eventEmitterToListenerMap (eventEmitter) {
    return eventEmitter.eventNames().map(eventName => {
      return {
        [eventName]: eventEmitter.on.bind(eventEmitter, eventName),
      }
    })
  }

  generateMetaMaskListenerMethodsMap () {
    return [
      ...this._eventEmitterToListenerMap(this._txController),
      ...this._eventEmitterToListenerMap(this._networkController),
      ...this._eventEmitterToListenerMap(this._blockTracker),
    ].reduce((acc, methodMap) => ({ ...acc, ...methodMap }))
  }

  _createMetaMaskEventListener (approvedPermissions) {
    const listenerMethodsMap = this.generateMetaMaskListenerMethodsMap()
    const approvedListenerMethodsMap = {}
    approvedPermissions.forEach(approvedPermission => {
      if (listenerMethodsMap[approvedPermission]) {
        approvedListenerMethodsMap[approvedPermission] = listenerMethodsMap[approvedPermission]
      }
    })

    return (eventName, cb) => {
      approvedListenerMethodsMap[eventName](cb)
    }
  }

  _generateApisToProvide (approvedPermissions, pluginName) {
    const apiList = approvedPermissions.map(perm => {
      const metamaskMethod = perm.match(/metamask_(.+)/)
      return metamaskMethod
        ? metamaskMethod[1]
        : perm
    })

    const onMetaMaskEvent = this._createMetaMaskEventListener(apiList)

    const possibleApis = {
      updatePluginState: this.updatePluginState.bind(this, pluginName),
      getPluginState: this.getPluginState.bind(this, pluginName),
      onNewTx: () => {},
      onUnlock: this._onUnlock,
      ...this.getApi(),
    }
    const registerRpcMessageHandler = this._registerRpcMessageHandler.bind(this, pluginName)
    const apisToProvide = {
      onMetaMaskEvent,
      registerRpcMessageHandler,
      getAppKey: () => this.getAppKeyForDomain(pluginName),
    }
    apiList.forEach(apiKey => {
      apisToProvide[apiKey] = possibleApis[apiKey]
    })
    return apisToProvide
  }

  _registerRpcMessageHandler (pluginName, handler) {
    this.rpcMessageHandlers.set(pluginName, handler)
  }

  _startPlugin (pluginName, approvedPermissions, sourceCode, ethereumProvider) {
    const apisToProvide = this._generateApisToProvide(approvedPermissions, pluginName)
    Object.assign(ethereumProvider, apisToProvide)
    try {
      const sessedPlugin = this.rootRealm.evaluate(sourceCode, {
        wallet: ethereumProvider,
        console, // Adding console for now for logging purposes.
        BigInt,
        window: {
          crypto,
          SubtleCrypto,
          fetch,
          XMLHttpRequest,
          WebSocket,
        },
        crypto,
        SubtleCrypto,
        fetch,
        XMLHttpRequest,
        WebSocket,
      })
      sessedPlugin()
    } catch (err) {
      this.deletePlugin(pluginName)
      throw err
    }
    this._setPluginToActive(pluginName)
    return true
  }

  async _setPluginToActive (pluginName) {
    this._updatePlugin(pluginName, 'isActive', true)
  }

  async _setPluginToInActive (pluginName) {
    this._updatePlugin(pluginName, 'isActive', false)
  }

  async _updatePlugin (pluginName, property, value) {
    const plugins = this.store.getState().plugins
    const plugin = plugins[pluginName]
    const newPlugin = { ...plugin, [property]: value }
    const newPlugins = { ...plugins, [pluginName]: newPlugin }
    this.store.updateState({
      plugins: newPlugins,
    })
  }
}

module.exports = PluginsController