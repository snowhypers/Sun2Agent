'use strict';

const chalk = require('chalk');
const { MODELS } = require('../../config/appConfig');
const providers = require('../../core/providers');

const ADD_PROVIDER = '__add_provider__';
const ADD_MODEL = '__add_model__';

function required(label) {
  return (value) => String(value || '').trim() ? true : `${label} is required.`;
}

async function addCustomProvider(ctx, config) {
  const answers = {};
  for (const question of [
    { type: 'input', name: 'customProviderName', message: 'Provider name:  ', validate: required('Provider name') },
    {
      type: 'input',
      name: 'customProviderBaseUrl',
      message: 'OpenAI-compatible base URL:  ',
      validate: providers.openaiCompatible.validateBaseUrl
    },
    {
      type: 'password',
      name: 'customProviderApiKey',
      message: 'API key:  ',
      mask: '*',
      validate: required('API key')
    },
    { type: 'input', name: 'customProviderModel', message: 'Model ID:  ', validate: required('Model ID') },
    {
      type: 'confirm',
      name: 'customProviderTools',
      message: 'Does this provider support OpenAI tool calling?  ',
      default: true
    }
  ]) {
    const answer = await ctx.promptBack([question]);
    if (!answer) return null;
    Object.assign(answers, answer);
  }

  const existing = providers.customProviders(config);
  const name = answers.customProviderName.trim();
  const model = answers.customProviderModel.trim();
  const provider = {
    id: providers.openaiCompatible.uniqueId(name, existing),
    name,
    type: 'openai-compatible',
    baseUrl: providers.openaiCompatible.normalizeBaseUrl(answers.customProviderBaseUrl),
    apiKey: answers.customProviderApiKey.trim(),
    models: [model],
    activeModel: model,
    supportsTools: answers.customProviderTools
  };
  return {
    activeProvider: provider.id,
    providers: [...existing, provider]
  };
}

async function selectCustomModel(ctx, config, providerId) {
  const custom = providers.customProviders(config).map((provider) => ({
    ...provider,
    models: [...provider.models]
  }));
  const provider = custom.find((item) => item.id === providerId);
  if (!provider) return null;

  const selected = await ctx.promptBack([{
    type: 'list',
    name: 'customModel',
    message: 'Select a model:  ' + chalk.gray('(esc to cancel)'),
    choices: [
      ...provider.models.map((model) => ({ name: model, value: model })),
      { name: 'Add another model ID', value: ADD_MODEL }
    ],
    default: provider.activeModel
  }]);
  if (!selected) return null;

  let model = selected.customModel;
  if (model === ADD_MODEL) {
    const added = await ctx.promptBack([{
      type: 'input',
      name: 'customProviderModel',
      message: 'Model ID:  ',
      validate: required('Model ID')
    }]);
    if (!added) return null;
    model = added.customProviderModel.trim();
    if (!provider.models.includes(model)) provider.models.push(model);
  }
  provider.activeModel = model;
  return { activeProvider: provider.id, providers: custom };
}

async function configureProvider(ctx, config) {
  const custom = providers.customProviders(config);
  const selected = await ctx.promptBack([{
    type: 'list',
    name: 'providerChoice',
    message: 'Select AI provider:  ' + chalk.gray('(esc to cancel)'),
    choices: [
      { name: `${providers.NVIDIA_NAME}  ${chalk.cyan('[built-in]')}`, value: providers.NVIDIA_ID },
      ...custom.map((provider) => ({
        name: `${provider.name}  ${chalk.cyan('[OpenAI-compatible]')}`,
        value: provider.id
      })),
      { name: 'Add custom OpenAI-compatible provider', value: ADD_PROVIDER }
    ],
    default: config.activeProvider || providers.NVIDIA_ID
  }]);
  if (!selected) return null;

  if (selected.providerChoice === ADD_PROVIDER) return addCustomProvider(ctx, config);
  if (selected.providerChoice !== providers.NVIDIA_ID) {
    return selectCustomModel(ctx, config, selected.providerChoice);
  }

  const key = await ctx.promptBack([{
    type: 'password',
    name: 'apiKey',
    message: 'Paste your NVIDIA NIM API key:  ' + chalk.gray('(esc to cancel)'),
    mask: '*',
    default: config.apiKey || undefined,
    validate: required('API key')
  }]);
  if (!key) return null;
  const model = await ctx.promptBack([{
    type: 'list',
    name: 'model',
    message: 'Select a model:  ' + chalk.gray('(esc to cancel)'),
    choices: MODELS.map((item) => ({
      name: `${item.name}  ${chalk.cyan('[' + item.tag + ']')}`,
      value: item.id
    })),
    default: config.model
  }]);
  if (!model) return null;
  return {
    activeProvider: providers.NVIDIA_ID,
    providers: custom,
    apiKey: key.apiKey,
    model: model.model
  };
}

module.exports = { configureProvider };
