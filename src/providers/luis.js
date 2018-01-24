import axios from 'axios'
import _ from 'lodash'
import crypto from 'crypto'
import Promise from 'bluebird'

import Provider from './base'
import Entities from './entities'

const LUIS_APP_VERSION = '1.0' // Static, we're not using this as everything is source-controlled in your bot
const LUIS_HASH_KVS_KEY = 'nlu/luis/updateMetadata'

// TODO Check if in Sync + Sync if needed
// TODO Add new Provider Entities (Guide, API Hooks)
// TODO UI Sync Status + Sync Button
// TODO Continuous learning backend
// TODO Continuous learning frontend

export default class LuisProvider extends Provider {
  constructor(config, logger, storage, parser, kvs) {
    super('luis', logger, storage, parser)

    this.appId = config.luisAppId
    this.programmaticKey = config.luisProgrammaticKey
    this.appSecret = config.luisAppSecret
    this.appRegion = config.luisAppRegion
    this.kvs = kvs
  }

  async getRemoteVersion() {
    try {
      const res = await axios.get(
        `https://westus.api.cognitive.microsoft.com/luis/api/v2.0/apps/${this.appId}/versions`,
        {
          headers: {
            'Ocp-Apim-Subscription-Key': this.programmaticKey
          }
        }
      )

      return _.find(res.data, { version: LUIS_APP_VERSION })
    } catch (err) {
      this.logger.debug('[NLU::Luis] Could not fetch app versions')
      return []
    }
  }

  async deleteVersion() {
    try {
      const del = await axios.delete(
        `https://westus.api.cognitive.microsoft.com/luis/api/v2.0/apps/${this.appId}/versions/${LUIS_APP_VERSION}/`,
        {
          headers: {
            'Ocp-Apim-Subscription-Key': this.programmaticKey
          }
        }
      )

      if (del.statusCode === 200) {
        this.logger.debug('[NLU::Luis] Removed old version of the model')
      }
    } catch (err) {
      this.logger.debug('[NLU::Luis] Could not remove old version of the model')
    }
  }

  async getAppInfo() {
    try {
      const response = await axios.get(`https://westus.api.cognitive.microsoft.com/luis/api/v2.0/apps/${this.appId}`, {
        headers: {
          'Ocp-Apim-Subscription-Key': this.programmaticKey
        }
      })
      return response.data
    } catch (err) {
      throw new Error('[NLU::Luis] Could not find app ' + this.appId)
    }
  }

  async isInSync(localIntents, remoteVersion) {
    const intentsHash = crypto
      .createHash('md5')
      .update(JSON.stringify(localIntents))
      .digest('hex')

    const metadata = await this.kvs.get(LUIS_HASH_KVS_KEY)

    return metadata && metadata.hash === intentsHash && metadata.time === remoteVersion.lastModifiedDateTime
  }

  async onSyncSuccess(localIntents, remoteVersion) {
    const intentsHash = crypto
      .createHash('md5')
      .update(JSON.stringify(localIntents))
      .digest('hex')

    await this.kvs.set(LUIS_HASH_KVS_KEY, {
      hash: intentsHash,
      time: remoteVersion.lastModifiedDateTime
    })
  }

  async sync() {
    let intents = await this.storage.getIntents()
    let currentVersion = await this.getRemoteVersion()

    if (await this.isInSync(intents, currentVersion)) {
      this.logger.debug('[NLU::Luis] Model is up to date')
      return
    } else {
      this.logger.debug('[NLU::Luis] The model needs to be updated')
    }

    if (currentVersion) {
      this.logger.debug('[NLU::Luis] Deleting old version of the model')
      await this.deleteVersion()
    }

    const utterances = []
    const builtinEntities = []

    intents.forEach(intent => {
      intent.utterances.forEach(utterance => {
        const extracted = this.parser.extractLabelsFromCanonical(utterance, intent.entities)
        const entities = []

        extracted.labels.forEach(label => {
          const entity = Entities[label.type]

          if (!entity || !label.type.startsWith('@native.')) {
            throw new Error(
              '[NLU::Luis] Unknown entity: ' + label.type + '. Botpress NLU only supports native entities for now.'
            )
          }

          if (!entity['@luis']) {
            throw new Error("[NLU::Luis] LUIS doesn't support entity of type " + label.type)
          }

          if (builtinEntities.indexOf(entity['@luis']) === -1) {
            builtinEntities.push(entity['@luis'])
          }

          entities.push({
            entity: entity['@luis'],
            startPos: label.start,
            endPos: label.end
          })
        })

        utterances.push({
          text: extracted.text,
          intent: intent.name,
          entities: entities
        })
      })
    })

    const appInfo = await this.getAppInfo()

    const body = {
      luis_schema_version: '2.1.0',
      versionId: LUIS_APP_VERSION,
      name: appInfo.name,
      desc: appInfo.description,
      culture: appInfo.culture,
      intents: intents.map(i => ({ name: i.name })),
      entities: [],
      composites: [],
      closedLists: [],
      bing_entities: builtinEntities,
      model_features: [],
      regex_features: [],
      utterances: utterances
    }

    try {
      const result = await axios.post(
        `https://westus.api.cognitive.microsoft.com/luis/api/v2.0/apps/${this
          .appId}/versions/import?versionId=${LUIS_APP_VERSION}`,
        body,
        {
          headers: {
            'Ocp-Apim-Subscription-Key': this.programmaticKey
          }
        }
      )

      await this.train()

      currentVersion = await this.getRemoteVersion()
      await this.onSyncSuccess(intents, currentVersion)

      this.logger.info('[NLU::Luis] Synced model [' + result.data + ']')
    } catch (err) {
      const detailedError = _.get(err, 'response.data.error.message')
      this.logger.error('[NLU::Luis] Could not sync the model. Error = ' + detailedError || (err && err.message))
    }
  }

  async train() {
    let res = await axios.post(
      `https://westus.api.cognitive.microsoft.com/luis/api/v2.0/apps/${this.appId}/versions/${LUIS_APP_VERSION}/train`,
      {},
      {
        headers: {
          'Ocp-Apim-Subscription-Key': this.programmaticKey
        }
      }
    )

    if (res.data.status !== 'Queued') {
      throw new Error('Expected training to be Queued but was: ' + res.data.status)
    }

    while (true) {
      res = await axios.get(
        `https://westus.api.cognitive.microsoft.com/luis/api/v2.0/apps/${this
          .appId}/versions/${LUIS_APP_VERSION}/train`,
        {
          headers: {
            'Ocp-Apim-Subscription-Key': this.programmaticKey
          }
        }
      )

      const models = res.data

      const percent = (models.length - _.filter(models, m => m.details.status === 'InProgress').length) / models.length

      const error = _.find(models, { status: 'Fail' })

      if (error) {
        throw new Error(
          `[NLU::Luis] Error training model "${error.modelId}", reason is "${error.details.failureReason}"`
        )
      }

      if (percent >= 1) {
        this.logger.debug('[NLU::Luis] Model trained (100%)')
        break
      } else {
        this.logger.debug('[NLU::Luis] Training... ' + percent.toFixed(2) * 100 + '%')
      }

      await Promise.delay(1000)
    }

    await axios.post(
      `https://westus.api.cognitive.microsoft.com/luis/api/v2.0/apps/${this.appId}/publish`,
      {
        versionId: LUIS_APP_VERSION,
        isStaging: !this.isProduction,
        region: 'westus'
      },
      {
        headers: {
          'Ocp-Apim-Subscription-Key': this.programmaticKey
        }
      }
    )
  }

  async extractEntities(incomingText) {}

  async classifyIntent(incomingText) {}
}
