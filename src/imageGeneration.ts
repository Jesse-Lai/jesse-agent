export interface ImageGenerationInput {
  prompt: string
  signal?: AbortSignal
  model?: string
  size?: '1024x1024' | '1024x1536' | '1536x1024'
}

export interface GeneratedImage {
  dataURL: string
  revisedPrompt?: string
}

interface ImagesGenerationResponse {
  data?: Array<{
    b64_json?: string
    revised_prompt?: string
  }>
}

interface ResponsesImageGenerationResponse {
  output?: Array<{
    type?: string
    result?: string
    revised_prompt?: string
  }>
}

/** Generate one office-ready image through the configured Images/Responses endpoint. */
export async function generateImage(input: ImageGenerationInput): Promise<GeneratedImage> {
  const timeoutSignal = AbortSignal.timeout(180_000)
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal
  const imageBaseURL = process.env.LLM_IMAGE_BASE_URL?.trim()
  if (imageBaseURL) {
    if (!imageBaseURL.includes('/images/generations')) {
      throw new Error('LLM_IMAGE_BASE_URL 必须指向 /images/generations 接口。')
    }

    const response = await fetch(imageBaseURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders({
          key: process.env.LLM_IMAGE_API_KEY ?? process.env.LLM_API_KEY,
          baseURL: imageBaseURL,
          header: process.env.LLM_IMAGE_API_KEY_HEADER ?? process.env.LLM_API_KEY_HEADER,
        }),
      },
      body: JSON.stringify({
        prompt: input.prompt,
        n: 1,
        size: input.size ?? '1536x1024',
        quality: 'medium',
        output_format: 'png',
      }),
      signal,
    })
    if (!response.ok) throw new Error(`图片生成请求失败 ${response.status}: ${await response.text()}`)

    const image = (await response.json() as ImagesGenerationResponse).data?.[0]
    if (!image?.b64_json) throw new Error('图片生成完成，但响应中没有图片。')
    return {
      dataURL: `data:image/png;base64,${image.b64_json}`,
      revisedPrompt: image.revised_prompt,
    }
  }

  const baseURL = process.env.LLM_BASE_URL ?? 'http://localhost:4399/v1'
  const model = process.env.LLM_MODEL ?? 'gpt-4o-2024-11-20'
  const visualBaseURL = process.env.LLM_VISUAL_BASE_URL?.trim() || baseURL
  const visualModel = input.model ?? (
    process.env.LLM_IMAGE_MODEL?.trim()
    || process.env.LLM_VISUAL_MODEL?.trim()
    || model
  )
  if (!visualBaseURL.includes('/responses')) {
    throw new Error('图片生成需要配置 Responses API：请设置 LLM_VISUAL_BASE_URL。')
  }

  const imageDeployment = process.env.LLM_IMAGE_DEPLOYMENT?.trim()
  if (isAzureOpenAIEndpoint(visualBaseURL) && !imageDeployment) {
    throw new Error('Azure 图片生成尚未配置：请将图片模型的部署名填写到 LLM_IMAGE_DEPLOYMENT。')
  }

  const response = await fetch(visualBaseURL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(isAzureOpenAIEndpoint(visualBaseURL) && imageDeployment
        ? { 'x-ms-oai-image-generation-deployment': imageDeployment }
        : {}),
    },
    body: JSON.stringify({
      model: visualModel,
      input: input.prompt,
      tools: [{
        type: 'image_generation',
        size: input.size ?? '1536x1024',
        quality: 'medium',
      }],
      tool_choice: { type: 'image_generation' },
    }),
    signal,
  })
  if (!response.ok) throw new Error(`图片生成请求失败 ${response.status}: ${await response.text()}`)

  const json = await response.json() as ResponsesImageGenerationResponse
  const image = json.output?.find(item => item.type === 'image_generation_call' && Boolean(item.result))
  if (!image?.result) throw new Error('图片生成完成，但响应中没有图片。')
  return {
    dataURL: `data:image/png;base64,${image.result}`,
    revisedPrompt: image.revised_prompt,
  }
}

function authHeaders(options: {
  key?: string
  baseURL?: string
  header?: string
} = {}): Record<string, string> {
  const key = options.key ?? process.env.LLM_API_KEY ?? ''
  if (!key) return {}
  const baseURL = options.baseURL ?? process.env.LLM_BASE_URL ?? ''
  const header = options.header
    ?? process.env.LLM_API_KEY_HEADER
    ?? (baseURL.includes('cognitiveservices.azure.com') ? 'api-key' : 'Authorization')
  return header.toLowerCase() === 'api-key' ? { 'api-key': key } : { [header]: `Bearer ${key}` }
}

function isAzureOpenAIEndpoint(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname.endsWith('.cognitiveservices.azure.com')
      || hostname.endsWith('.openai.azure.com')
      || hostname.endsWith('.services.ai.azure.com')
  } catch {
    return false
  }
}
