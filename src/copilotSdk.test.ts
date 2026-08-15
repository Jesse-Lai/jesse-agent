import assert from 'node:assert/strict'
import test from 'node:test'
import { formatCopilotSDKError, resolveCopilotProviderConfig } from './copilotSdk.js'

test('Copilot SDK error formatter extracts nested messages instead of object Object', () => {
  assert.equal(
    formatCopilotSDKError({ error: { message: 'Authentication required' } }),
    'GitHub Copilot SDK: Authentication required',
  )
  assert.equal(
    formatCopilotSDKError({ code: 'session_failed' }),
    'GitHub Copilot SDK: {"code":"session_failed"}',
  )
})

test('Copilot SDK reuses the packaged Azure Responses configuration as a provider', () => {
  assert.deepEqual(resolveCopilotProviderConfig({
    LLM_API_MODE: 'copilot_sdk',
    LLM_BASE_URL: 'https://example.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview',
    LLM_API_KEY: 'secret',
    LLM_API_KEY_HEADER: 'api-key',
    LLM_MODEL: 'deployment-name',
    COPILOT_MODEL: 'gpt-5.6-sol',
  }), {
    type: 'azure',
    wireApi: 'responses',
    baseUrl: 'https://example.cognitiveservices.azure.com',
    apiKey: 'secret',
    azure: { apiVersion: '2025-04-01-preview' },
    modelId: 'gpt-5.6-sol',
    wireModel: 'deployment-name',
  })
})

test('an explicit GitHub token keeps Copilot SDK on native GitHub authentication', () => {
  assert.equal(resolveCopilotProviderConfig({
    LLM_API_MODE: 'copilot_sdk',
    LLM_BASE_URL: 'https://example.test/v1/responses',
    LLM_API_KEY: 'byok-key',
    COPILOT_GITHUB_TOKEN: 'github-token',
  }), undefined)
})
