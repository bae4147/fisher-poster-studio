# Fisher Poster Studio

Studio:        https://<your-worker>.workers.dev/
Hun's poster:  https://<your-worker>.workers.dev/lee/
A poster:      https://<your-worker>.workers.dev/p/<id>

## Deploy (Mac terminal, inside this folder)
1. npm install
2. npx wrangler login                      # opens the browser; sign in to Cloudflare
3. npx wrangler secret put OPENAI_API_KEY  # paste the OpenAI key when asked
4. npx wrangler deploy                     # if asked to create the POSTERS KV namespace, answer yes

ELEVENLABS_API_KEY, INVITE_CODES and TOKEN_SECRET are already on the
fisher-poster-voice Worker and are kept.

## Settings (wrangler.jsonc → "vars", redeploy after changing)
OPENAI_POSTER_MODEL  model that drafts posters      (gpt-6.1-sol)
OPENAI_CHAT_MODEL    model that answers chat         (gpt-6-luna)
OPENAI_REASONING     effort for drafting             (medium)
PDF_DETAIL           low = cheaper, high = reads small print/figures better
MODEL_ID             ElevenLabs voice model          (eleven_multilingual_v2)

## Invite codes
Add or remove codes: npx wrangler secret put INVITE_CODES  (comma-separated list)
