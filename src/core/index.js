const path = require('path')
const dotenv = require('dotenv')
const { prompt } = require('inquirer')
const util = require('util')
const exec = util.promisify(require('child_process').exec)
const ComponentDeclarative = require('./declarative/serverless')
const {
  fileExists,
  readFile,
  copyDirContentsSync,
  coreComponentExists,
  loadComponent,
  prepareCredentials,
  api
} = require('../utils')

/**
 * Run a serverless.js file
 * @param {String} filePath - Path of the declarative file
 * @param {Object} config - Configuration
 */

class Context {
  constructor(config, rootFile = 'serverless.js') {
    this.stage = config.stage
    this.root = config.root
    this.rootFile = rootFile
    this.credentials = config.credentials
    this.verbose = config.verbose
    this.debug = config.debug
    this.watch = config.watch
  }
}

const runProgrammatic = async (filePath, config, ui) => {
  let result

  // Load Component
  const context = new Context(config)

  const Component = require(filePath)

  // Config CLI
  ui.config({
    stage: config.stage,
    parentComponent: Component.name
  })

  const component = new Component({ context, ui })

  try {
    // If method was provided, but doesn't exist, throw error
    if (config.method && !component[config.method]) {
      throw new Error(`Component "${Component.name}" does not have a "${config.method}" method`)
    }

    if (!config.method) {
      result = await component()
    } else {
      result = await component[config.method]()
    }
  } catch (error) {
    return ui.error(error, Component.name)
  }

  if (!context.watch) {
    // Cleanup CLI
    ui.close('done')
  }

  return result
}

/**
 * Run a serverless.yml, serverless.yaml or serverless.json file
 * @param {String} filePath - Path of the declarative file
 * @param {Object} config - Configuration
 */

const runDeclarative = async (filePath, config, ui) => {
  let Component, component, result

  const context = new Context(config, path.basename(filePath))

  // TODO: Handle loading errors and validate...
  const fileContent = await readFile(filePath)

  // If no config.method or config.instance has been provided, run the default method...
  if (!config.instance && !config.method) {
    // Config CLI
    ui.config({
      stage: config.stage,
      parentComponent: fileContent.name
    })

    try {
      component = new ComponentDeclarative({
        name: fileContent.name, // Must pass in name to ComponentDeclaractive
        context,
        ui
      })
      result = await component()
    } catch (error) {
      return ui.error(error, fileContent.name)
    }
  }

  // If config.method has been provided, run that...
  if (!config.instance && config.method) {
    // Config CLI
    ui.config({
      stage: config.stage,
      parentComponent: fileContent.name
    })

    component = new ComponentDeclarative({
      name: fileContent.name, // Must pass in name to ComponentDeclaractive
      context,
      ui
    })
    try {
      result = await component[config.method]()
    } catch (error) {
      return ui.error(error, fileContent.name)
    }
  }

  // If config.method and config.instance, load and run that component's method...
  if (config.instance && config.method) {
    let instanceName
    let componentName

    for (const instance in fileContent.components || {}) {
      const c = instance.split('::')[0] // eslint-disable-line
      const i = instance.split('::')[1]
      if (config.instance === i) {
        instanceName = i
        componentName = c
      }
    }

    // Check Component instance exists in serverless.yml
    if (!instanceName) {
      throw Error(`Component instance "${config.instance}" does not exist in your project.`)
    }

    // Check Component exists
    if (!(await coreComponentExists(componentName))) {
      throw Error(`Component "${componentName}" is not a valid Component.`)
    }

    // Config CLI
    ui.config({
      stage: config.stage,
      parentComponent: `${instanceName}`
    })

    Component = await loadComponent(componentName)
    component = new Component({
      id: `${context.stage}.${fileContent.name}.${instanceName}`, // Construct correct name of child Component
      context,
      ui
    })
    try {
      result = await component[config.method]()
    } catch (error) {
      return ui.error(error, componentName)
    }
  }

  if (!context.watch) {
    // Cleanup CLI
    ui.close('done')
  }

  return result
}

const runPrompt = async () => {
  // Add whitespace
  console.log('') // eslint-disable-line

  const selected = await prompt([
    {
      type: 'list',
      name: 'template',
      message: 'Pick a starting point:',
      paginated: true,
      choices: [
        { name: 'Create A New Component', value: 'component' },
        { name: 'Function', value: 'function' },
        { name: 'REST API', value: 'api' },
        { name: 'Website', value: 'website' },
        { name: 'Fullstack App', value: 'fullstack-app' },
        { name: 'Fullstack Realtime App', value: 'fullstack-realtime-app' }
      ]
    }
  ])

  // Add whitespace
  console.log('') // eslint-disable-line

  const templateDirPath = path.join(__dirname, '..', '..', 'templates', selected.template)

  copyDirContentsSync(templateDirPath, process.cwd())

  console.log(`  Successfully created "${selected.template}" in the current directory.`) // eslint-disable-line
  console.log(`  Check out the generated files for some helpful instructions.`) // eslint-disable-line

  if (selected.template === 'component') {
    console.log(`  Installing Dependencies...`) // eslint-disable-line
    await exec('npm install')
    console.log(`  Installed.  Run "components" for a quick tour.`) // eslint-disable-line
  }

  // Add whitespace
  console.log('') // eslint-disable-line

  process.exit(0)
}

/**
 * Identifies environment variables that are known vendor credentials and finds their corresponding SDK configuration properties
 * @param {Object} config - Configuration
 * @param {String} config.root - The root path of the parent Component.
 * @param {String} config.stage - The stage you wish to set in the context.
 * @param {String} config.instance - The instance name of an immediate child Component you want to target with the CLI.  Note: This only works with serverless.yml
 * @param {String} config.method - The method you want to call on the parent Component.
 * @param {Object} config.credentials - The credentials you wish to set in the context.
 * @param {String} config.verbose - If you wish to see outputs of all child Components.
 * @param {String} config.debug - If you wish to turn on debug mode.
 */

const run = async (config = {}, ui = api) => {
  // Configuration defaults
  config.root = config.root || process.cwd()
  config.stage = config.stage || 'dev'
  config.credentials = config.credentials || {}
  config.instance = config.instance || null
  config.method = config.method || null
  config.verbose = config.verbose || false
  config.debug = config.debug || false
  config.watch = config.watch || false

  if (config.verbose) {
    process.env.SERVERLESS_VERBOSE = true
  }
  if (config.debug) {
    process.env.SERVERLESS_DEBUG = true
  }

  // Load env vars
  let envVars = {}
  const defaultEnvFilePath = path.join(config.root, `.env`)
  const stageEnvFilePath = path.join(config.root, `.env.${config.stage}`)
  if (await fileExists(stageEnvFilePath)) {
    envVars = dotenv.config({ path: path.resolve(stageEnvFilePath) }).parsed || {}
  } else if (await fileExists(defaultEnvFilePath)) {
    envVars = dotenv.config({ path: path.resolve(defaultEnvFilePath) }).parsed || {}
  }

  // Prepare credentials
  config.credentials = prepareCredentials(envVars)

  // Determine programmatic or declarative usage
  const serverlessJsFilePath = path.join(config.root, 'serverless.js')
  const serverlessYmlFilePath = path.join(config.root, 'serverless.yml')
  const serverlessYamlFilePath = path.join(config.root, 'serverless.yaml')
  const serverlessJsonFilePath = path.join(config.root, 'serverless.json')

  try {
    if (await fileExists(serverlessJsFilePath)) {
      return await runProgrammatic(serverlessJsFilePath, config, ui)
    } else if (await fileExists(serverlessYmlFilePath)) {
      return await runDeclarative(serverlessYmlFilePath, config, ui)
    } else if (await fileExists(serverlessYamlFilePath)) {
      return await runDeclarative(serverlessYamlFilePath, config, ui)
    } else if (await fileExists(serverlessJsonFilePath)) {
      return await runDeclarative(serverlessJsonFilePath, config, ui)
    }

    // run prompt if serverless files not found
    await runPrompt()
  } catch (error) {
    return ui.error(error, 'Serverless Components')
  }
}

/**
 * Run a serverless.yml, serverless.yaml or serverless.json file
 * @param {String} filePath - Path of the declarative file
 * @param {Object} config - Configuration
 */

module.exports = run