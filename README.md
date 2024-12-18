# Client Side Tool Calling with the OpenAI WebRTC Realtime API

This project is a fork of [this repo](https://github.com/craigsdennis/talk-to-javascript-openai-workers) by my wonderful teammate [Craig Dennis](https://x.com/craigsdennis). It's a [Cloudflare Workers](https://developers.cloudflare.com) app using [Hono](https://honojs.dev) to relay the [OpenAI Realtime API](https://platform.openai.com/docs/api-reference/realtime) over WebRTC. The main file is static, then the resulting files are dynamic.

It edits Craig's fork to fill out a form on a webpage via your voice. When you submit the form, [Llama-3.2-3b-instruct hosted on Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/models/llama-3.2-3b-instruct/) generates gift recommendations for someone according to how you answer the questions, and then saves the gift recommendation and people can rate and thus rank the gift recommendations.

[<img src="https://img.youtube.com/vi/TcOytsfva0o/0.jpg">](https://youtu.be/TcOytsfva0o "Client Side Tool Calling with the OpenAI WebRTC Realtime API")


## Develop

Copy [.dev.vars.example](./.dev.vars.example) to `.dev.vars` and fill out your OpenAI API Key.

Install your dependencies

```bash
npm install
```

Run local server

```bash
npm run dev
```

## Deploy

Upload your OpenAI API key (secret)

```bash
npx wrangler secret put OPENAI_API_KEY
```

```bash
npm run deploy
```

The hand (in Craig's app) is a [HiWonder AI Hand](https://www.hiwonder.com/products/aihand?variant=41022039654487). AI and I reverse-engineered the mobile app to make it work over Bluetooth, see [the code in hand.js](./public/hand.js)
