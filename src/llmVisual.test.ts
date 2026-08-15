import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { generateImage, streamVisualPrompt } from './llm.js'

const originalFetch = globalThis.fetch
const originalLlmApiKey = process.env.LLM_API_KEY

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalLlmApiKey === undefined) delete process.env.LLM_API_KEY
  else process.env.LLM_API_KEY = originalLlmApiKey
  delete process.env.LLM_VISUAL_BASE_URL
  delete process.env.LLM_VISUAL_MODEL
  delete process.env.LLM_IMAGE_BASE_URL
  delete process.env.LLM_IMAGE_MODEL
  delete process.env.LLM_IMAGE_DEPLOYMENT
  delete process.env.LLM_IMAGE_API_KEY
  delete process.env.LLM_IMAGE_API_KEY_HEADER
})

describe('Companion visual model adapter', () => {
  it('sends screenshot pixels directly as an input_image and streams text', async () => {
    process.env.LLM_VISUAL_BASE_URL = 'https://example.test/openai/responses'
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      const stream = [
        'data: {"type":"response.output_text.delta","delta":"截图"}',
        'data: {"type":"response.output_text.delta","delta":"分析"}',
        'data: [DONE]',
        '',
      ].join('\n')
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }

    let result = ''
    for await (const delta of streamVisualPrompt({
      systemPrompt: '分析图片',
      prompt: '说明内容',
      imageDataURL: 'data:image/png;base64,AA==',
    })) result += delta

    assert.equal(result, '截图分析')
    const input = requestBody?.input as Array<{ content?: Array<Record<string, unknown>> }>
    assert.deepEqual(input[0]?.content?.[1], {
      type: 'input_image',
      image_url: 'data:image/png;base64,AA==',
      detail: 'auto',
    })
  })

  it('requests the image generation tool and returns a PNG data URL', async () => {
    process.env.LLM_VISUAL_BASE_URL = 'https://example.test/openai/responses'
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        output: [{ type: 'image_generation_call', result: 'aW1hZ2U=', revised_prompt: '办公配图' }],
      })
    }

    const image = await generateImage({ prompt: '生成一张办公配图' })

    assert.equal(image.dataURL, 'data:image/png;base64,aW1hZ2U=')
    assert.equal(image.revisedPrompt, '办公配图')
    assert.deepEqual(requestBody?.tool_choice, { type: 'image_generation' })
    assert.deepEqual(requestBody?.tools, [{ type: 'image_generation', size: '1536x1024', quality: 'medium' }])
  })

  it('uses a dedicated Azure Images API endpoint when configured', async () => {
    process.env.LLM_IMAGE_BASE_URL = 'https://example.cognitiveservices.azure.com/openai/deployments/gpt-image-1/images/generations?api-version=2025-04-01-preview'
    let requestedURL = ''
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = async (input, init) => {
      requestedURL = String(input)
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        data: [{ b64_json: 'aW1hZ2U=', revised_prompt: '办公配图' }],
      })
    }

    const image = await generateImage({ prompt: '生成一张办公配图' })

    assert.match(requestedURL, /\/images\/generations/)
    assert.equal(image.dataURL, 'data:image/png;base64,aW1hZ2U=')
    assert.equal(image.revisedPrompt, '办公配图')
    assert.deepEqual(requestBody, {
      prompt: '生成一张办公配图',
      n: 1,
      size: '1536x1024',
      quality: 'medium',
      output_format: 'png',
    })
  })

  it('prefers dedicated image credentials for direct Images API requests', async () => {
    process.env.LLM_IMAGE_BASE_URL = 'https://example.cognitiveservices.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-02-01'
    process.env.LLM_API_KEY = 'chat-key'
    process.env.LLM_IMAGE_API_KEY = 'image-key'
    process.env.LLM_IMAGE_API_KEY_HEADER = 'Authorization'
    let requestHeaders: Headers | undefined
    globalThis.fetch = async (_input, init) => {
      requestHeaders = new Headers(init?.headers)
      return Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] })
    }

    await generateImage({ prompt: '生成配图' })

    assert.equal(requestHeaders?.get('Authorization'), 'Bearer image-key')
    assert.equal(requestHeaders?.get('api-key'), null)
  })

  it('sends the required image deployment header to Azure Responses API', async () => {
    process.env.LLM_VISUAL_BASE_URL = 'https://example.openai.azure.com/openai/responses?api-version=preview'
    process.env.LLM_IMAGE_DEPLOYMENT = 'image-generation-prod'
    let requestHeaders: Headers | undefined
    globalThis.fetch = async (_input, init) => {
      requestHeaders = new Headers(init?.headers)
      return Response.json({
        output: [{ type: 'image_generation_call', result: 'aW1hZ2U=' }],
      })
    }

    await generateImage({ prompt: '生成配图' })

    assert.equal(
      requestHeaders?.get('x-ms-oai-image-generation-deployment'),
      'image-generation-prod',
    )
  })

  it('explains the missing Azure image deployment before sending a request', async () => {
    process.env.LLM_VISUAL_BASE_URL = 'https://example.cognitiveservices.azure.com/openai/responses'
    let requested = false
    globalThis.fetch = async () => {
      requested = true
      return Response.json({})
    }

    await assert.rejects(
      generateImage({ prompt: '生成配图' }),
      /LLM_IMAGE_DEPLOYMENT/,
    )
    assert.equal(requested, false)
  })

  it('rejects a successful visual response that contains no model output', async () => {
    process.env.LLM_VISUAL_BASE_URL = 'https://example.test/openai/responses'
    globalThis.fetch = async () => new Response('data: {"type":"response.completed"}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })

    const consume = async () => {
      for await (const _delta of streamVisualPrompt({
        systemPrompt: '分析图片',
        prompt: '说明内容',
        imageDataURL: 'data:image/png;base64,AA==',
      })) {
        // Drain the stream so terminal validation runs.
      }
    }

    await assert.rejects(consume, /没有返回内容/)
  })
})
