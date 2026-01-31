import { createOpenRouter } from '@openrouter/ai-sdk-provider';

export const hackclub = createOpenRouter({
  apiKey: process.env.HACK_CLUB_AI_API_KEY,
  baseUrl: 'https://ai.hackclub.com/proxy/v1',
});

export let model: string = "moonshotai/kimi-k2.5";

export function setModel(newModel: string) {
  model = newModel;
}
