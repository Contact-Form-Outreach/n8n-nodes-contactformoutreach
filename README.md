# Contact Form Outreach for n8n

A community node package for n8n. Contact Form Outreach is opt-out-aware B2B outreach: it sends a business message to companies through their website contact forms, and you pay for the messages it sends. The node uses the public API and webhooks only.

## What it offers

Trigger node, "Contact Form Outreach Trigger":

- Message Sent
- Company Could Not Be Reached
- Company Replied
- Campaign Finished

Each can be narrowed to one campaign.

Action node, "Contact Form Outreach". Pick a resource, then an operation:

- Campaign: Create, Find, Send, Stop
- Company: Add Company to Campaign, Add Companies to Campaign, Find Company on Campaign
- Message: Create
- Company Register: Search Company Register, Find Company Website

- Add Companies to Campaign: up to 50 websites in one step. Each comes back with added or not, and why not.
- Search Company Register: by trade, place and name. Each company returned has its own price. It returns 50 companies unless you set a lower limit.
- Find Company Website: the website of one register company. A website found has its own price, once. The key needs the registry website permission. The step does not wait: if the search is still running, it returns the state queued or working; run it again later.
- The register country is a dropdown read from the API.

## How it works

- The person pastes an API key once. n8n adds it to every call. The node never reads it.
- Every write carries its own Idempotency-Key.
- Turning a workflow on adds one webhook endpoint. Turning it off removes it.
- The endpoint's signing secret is kept in the workflow's own data. A post that is not signed with it gets 401 and starts nothing.
- Campaign, Send signs the statement the API shows, and only when "I Confirm" is on.

## Make an API key

1. Sign in to Contact Form Outreach.
2. Open Settings, API keys: https://app.contactformoutreach.com/settings/api-keys
3. Make a new key with the read, write and webhooks permissions. Add the registry permissions if you use the company register steps.
4. Copy the key. It is shown once.
5. In n8n, add a "Contact Form Outreach API" credential and paste the key.

API reference: https://contactformoutreach.com/developers

## Example workflow

Add companies from a sheet to a campaign and get told when each message is sent.

1. Workflow 1: a sheet trigger (new row) with a `website` column.
2. Contact Form Outreach, Company, Add Company to Campaign: pick the campaign, set Website to `{{$json.website}}`.
3. Workflow 2: Contact Form Outreach Trigger, event Message Sent, narrowed to the same campaign.
4. A notification node that posts the company website and `sent_at` from the event.
5. When the list is ready, run Contact Form Outreach, Campaign, Send once with "I Confirm" on.

If the API answers 429 (too many requests), the step stops with a clear message. Wait a minute and run it again.

## Check

```bash
npm install
```

```bash
npm test
```

The test builds the package and runs it against a stand-in for n8n and for the API. No network and no account.

## Publish

1. `npm publish` from this folder. The package name starts with `n8n-nodes-`, so n8n finds it.
2. People install it in n8n under Settings, Community Nodes.
