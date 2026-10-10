# Dated evaluation notes

These are small smoke runs against fictional fixtures. They are not held-out accuracy, a reliability percentage, or a reason to turn a matcher on in production.

## 7 October 2026 — JEV selector smoke

`JEV_MODE=shadow npm run eval:matching`: 20/20 checks passed with `jev-1.13.0`, zero wrong selections and zero unavailable results. Calls took approximately 0.43–1.33 seconds. This does not measure real-catalogue accuracy.

## 7 October 2026 — acceptance conversations

`openai/gpt-5-mini` passed five of six acceptance cases on the first full run. The custom-price case left the customer unresolved. An isolated retry passed, so the precise cause was not established. Existing-customer guidance was clarified, and the next full run passed six of six.

## 8 October 2026 — matching workflow

`JEV_MODE=on npm run eval:matching:workflow`: all 10 smoke cases passed after a repeat run exposed a city/VAT conflict and a deterministic city constraint was added.

## 9 October 2026 — multi-turn conversations

`openai/gpt-5-mini` passed 14 of 14 conversation cases after the prompt and API fixes that run prompted.
