// Starts a workflow when something happens. Turning the workflow on adds a webhook endpoint of
// the public API; turning it off removes it.
import type {
	IDataObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes } from 'n8n-workflow';
import { call, CREDENTIAL, flatEvent, signedBy, statusOf } from './api';

export const EVENTS: Record<string, string[]> = {
	messageSent: ['target.submitted'],
	companyNotReached: ['target.failed', 'target.no_form', 'target.blocked'],
	// A reply read from the mailbox, forwarded, or recorded by hand.
	companyReplied: ['target.replied'],
	campaignFinished: ['campaign.done'],
};

// The decision for one incoming post: which rows start the workflow, or that the post is refused.
export function incoming(
	secret: string | undefined,
	headers: Record<string, unknown>,
	raw: string | null,
	types: string[],
	onlyCampaign: string,
	nowMs = Date.now(),
): { refused: boolean; rows: IDataObject[] } {
	// A post that is not signed with this endpoint's secret is not ours: nothing runs.
	if (!signedBy(secret, headers, raw, nowMs)) return { refused: true, rows: [] };
	let e: IDataObject;
	try {
		e = JSON.parse(raw as string) as IDataObject;
	} catch {
		return { refused: false, rows: [] };
	}
	if (!e || !e.id || !types.includes(String(e.type))) return { refused: false, rows: [] };
	const row = flatEvent(e);
	return { refused: false, rows: onlyCampaign && row.campaign_id !== onlyCampaign ? [] : [row] };
}

export class ContactFormOutreachTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Contact Form Outreach Trigger',
		name: 'contactFormOutreachTrigger',
		icon: 'file:contactformoutreach.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Starts the workflow when a message is sent, a company cannot be reached or a campaign finishes',
		defaults: { name: 'Contact Form Outreach Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL, required: true }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				default: 'messageSent',
				options: [
					{ name: 'Campaign Finished', value: 'campaignFinished', description: 'A campaign has sent everything it could' },
					{ name: 'Company Could Not Be Reached', value: 'companyNotReached', description: 'A company has no contact form or the message could not be sent' },
					{ name: 'Company Replied', value: 'companyReplied', description: 'A company has replied to a message. Automatic replies and bounces do not count.' },
					{ name: 'Message Sent', value: 'messageSent', description: 'A message has been sent to a company through its contact form' },
				],
			},
			{
				displayName: 'Campaign Name or ID',
				name: 'campaignId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getCampaigns' },
				default: '',
				description: 'Leave empty for every campaign. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
		],
	};

	methods = {
		loadOptions: {
			async getCampaigns(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const page = await call(this, 'GET', '/campaigns', undefined, { limit: 200 });
				const rows = ((page.campaigns ?? page.items ?? []) as IDataObject[]).map((c) => ({
					name: String(c.name ?? c.id),
					value: String(c.id),
				}));
				return [{ name: 'Every Campaign', value: '' }, ...rows];
			},
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				if (!data.endpointId || !data.secret) return false;
				// The endpoint must still be there, point here and listen for this event.
				try {
					const e = await call(this, 'GET', `/webhook-endpoints/${data.endpointId}`);
					const ep = ((e.endpoint ?? e) as IDataObject) ?? {};
					const want = EVENTS[this.getNodeParameter('event') as string] ?? [];
					const have = (ep.event_types ?? []) as string[];
					const same = ep.url === this.getNodeWebhookUrl('default') && want.every((t) => have.includes(t)) && have.length === want.length;
					if (same) return true;
				} catch (err) {
					if (![404, 410].includes(statusOf(err) ?? 0)) throw new NodeApiError(this.getNode(), err as JsonObject);
					delete data.endpointId;
					delete data.secret;
					return false;
				}
				// It is there but no longer matches: remove it, so create makes a fresh one.
				try {
					await call(this, 'DELETE', `/webhook-endpoints/${data.endpointId}`);
				} catch (err) {
					if (![404, 410].includes(statusOf(err) ?? 0)) throw new NodeApiError(this.getNode(), err as JsonObject);
				}
				delete data.endpointId;
				delete data.secret;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const event = this.getNodeParameter('event') as string;
				const made = await call(this, 'POST', '/webhook-endpoints', {
					url: this.getNodeWebhookUrl('default') as string,
					event_types: EVENTS[event],
					description: `n8n: ${event}`,
				});
				if (!made.id || !made.secret) return false;
				const data = this.getWorkflowStaticData('node');
				data.endpointId = made.id;
				data.secret = made.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				if (data.endpointId) {
					try {
						await call(this, 'DELETE', `/webhook-endpoints/${data.endpointId}`);
					} catch (err) {
						// Already gone is the result that was wanted.
						if (![404, 410].includes(statusOf(err) ?? 0)) return false;
					}
				}
				delete data.endpointId;
				delete data.secret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject() as unknown as { rawBody?: Buffer | string };
		const raw = req.rawBody === undefined || req.rawBody === null ? null : req.rawBody.toString('utf8');
		const data = this.getWorkflowStaticData('node');
		const verdict = incoming(
			data.secret as string | undefined,
			this.getHeaderData() as unknown as Record<string, unknown>,
			raw,
			EVENTS[this.getNodeParameter('event') as string] ?? [],
			String(this.getNodeParameter('campaignId', '') ?? ''),
		);
		if (verdict.refused) {
			this.getResponseObject().status(401).json({ message: 'The event was not signed by Contact Form Outreach.' });
			return { noWebhookResponse: true };
		}
		if (!verdict.rows.length) return { webhookResponse: { ok: true } };
		return { workflowData: [this.helpers.returnJsonArray(verdict.rows)] };
	}
}
