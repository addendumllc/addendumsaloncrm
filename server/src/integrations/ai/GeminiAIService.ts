import { config } from '../../config.js';
import { AnthropicAIService } from './AnthropicAIService.js';

/**
 * Google Gemini (Google AI Studio API key; the free tier has daily limits) — the same drafting, message analysis and
 * free-form writing as Claude, through Gemini's generateContent. Server-side only; the key never reaches the browser.
 */
export class GeminiAIService extends AnthropicAIService {
  readonly provider = 'gemini' as const;

  protected async complete(system: string, user: string, maxTokens = 400): Promise<string> {
    const c = config();
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.GEMINI_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': c.GEMINI_API_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        // Room for the model's own thinking on top of the answer.
        generationConfig: { maxOutputTokens: Math.max(maxTokens, 400) * 4, temperature: 0.8 },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const j: any = await res.json().catch(() => ({}));
      throw new Error(`Gemini API ${res.status}${j?.error?.message ? `: ${j.error.message}` : ''}`);
    }
    const json: any = await res.json();
    return (json.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('').trim();
  }
}
