// What a workflow can do: write a message, start a campaign, add a company, send, stop, look up.
// many companies at once, the company register, and a register company's website.
import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { call, CREDENTIAL, REGISTRY, statusOf } from './api';

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v));
const bare = (v: string): string =>
	v.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
const rowsOf = (page: IDataObject, key: string): IDataObject[] => ((page[key] ?? page.items ?? []) as IDataObject[]);

const forOps = (...operation: string[]) => ({ show: { operation } });
const CAMPAIGN_OPS = ['addCompany', 'addCompanies', 'sendCampaign', 'stopCampaign', 'findCompany'];
const REGISTER_OPS = ['searchRegister', 'findWebsite'];
const MOST = 50;
// A refusal that is about the account, not about one company: going on would only repeat it.
const STOPS = [401, 402, 429, 503];

// One operation, one function. Each returns the rows the next node sees.
export const operations: Record<string, (ctx: IExecuteFunctions, i: number) => Promise<IDataObject[]>> = {
	async createMessage(ctx, i) {
		const body: IDataObject = {};
		const fields: Array<[string, string]> = [
			['name', 'name'], ['subject', 'subject'], ['body', 'message'], ['sender_company', 'senderCompany'],
			['sender_first_name', 'senderFirstName'], ['sender_last_name', 'senderLastName'], ['sender_email', 'senderEmail'],
			['sender_phone', 'senderPhone'], ['sender_website', 'senderWebsite'],
		];
		for (const [api, param] of fields) {
			const v = text(ctx.getNodeParameter(param, i, ''));
			if (v) body[api] = v;
		}
		const a = await call(ctx, 'POST', '/templates', body);
		return [{ id: a.template_id ?? a.id ?? null, name: body.name, subject: body.subject }];
	},

	async createCampaign(ctx, i) {
		const name = text(ctx.getNodeParameter('name', i));
		const a = await call(ctx, 'POST', '/campaigns', {
			name,
			keywords: ['own list'],
			send_enquiries: true,
			template_id: text(ctx.getNodeParameter('templateId', i)),
			country: (text(ctx.getNodeParameter('country', i, 'PL')) || 'PL').toUpperCase(),
		});
		return [{ id: a.campaign_id ?? a.id ?? null, name, state: 'draft' }];
	},

	async addCompany(ctx, i) {
		const id = text(ctx.getNodeParameter('campaignId', i));
		const website = text(ctx.getNodeParameter('website', i));
		const a = await call(ctx, 'POST', `/campaigns/${id}/targets`, { url: website });
		return [{ id: a.target_id ?? a.id ?? null, campaign_id: id, website: a.domain ?? website, state: a.state ?? 'pending' }];
	},

	async sendCampaign(ctx, i) {
		const id = text(ctx.getNodeParameter('campaignId', i));
		if (ctx.getNodeParameter('confirm', i, false) !== true) {
			throw new NodeOperationError(ctx.getNode(), 'Nothing was sent: the statement was not confirmed.', { itemIndex: i });
		}
		const max = Number(ctx.getNodeParameter('maxMessages', i, 0));
		if (Number.isInteger(max) && max > 0) await call(ctx, 'PATCH', `/campaigns/${id}`, { delivery_target: max });
		const s = await call(ctx, 'GET', `/campaigns/${id}/signoff`);
		await call(ctx, 'POST', `/campaigns/${id}/signoff`, { wording: s.wording, ...(s.list_hash ? { list_hash: s.list_hash } : {}) });
		const a = await call(ctx, 'POST', `/campaigns/${id}/send`);
		return [{
			id,
			started: true,
			job_id: a.id ?? null,
			companies_ready: typeof s.ready === 'number' ? s.ready : null,
			signed_statement: s.wording,
		}];
	},

	async stopCampaign(ctx, i) {
		const id = text(ctx.getNodeParameter('campaignId', i));
		const a = await call(ctx, 'POST', `/campaigns/${id}/stop`);
		return [{ id, stopped: true, stop_reason: a.stop_reason ?? null }];
	},

	async findCampaign(ctx, i) {
		const name = text(ctx.getNodeParameter('name', i));
		const want = name.toLowerCase();
		const page = await call(ctx, 'GET', '/campaigns', undefined, { limit: 200, search: name });
		const rows = rowsOf(page, 'campaigns').map((c) => ({ id: c.id, name: c.name, state: c.state }));
		const exact = rows.filter((c) => text(c.name).toLowerCase() === want);
		return exact.length ? exact.slice(0, 1) : rows.filter((c) => text(c.name).toLowerCase().includes(want)).slice(0, 1);
	},

	async findCompany(ctx, i) {
		const id = text(ctx.getNodeParameter('campaignId', i));
		const want = bare(text(ctx.getNodeParameter('website', i)));
		for (let offset = 0; offset < 5000; offset += 500) {
			const page = await call(ctx, 'GET', `/campaigns/${id}/targets`, undefined, { limit: 500, offset });
			const rows = rowsOf(page, 'targets');
			const t = rows.find((r) => text(r.domain).toLowerCase().replace(/^www\./, '') === want);
			if (t) {
				return [{
					id: t.id, campaign_id: id, website: t.domain, state: t.state,
					sent: t.reason_group === 'delivered', sent_at: t.submitted_at ?? null,
				}];
			}
			if (rows.length < 500) break;
		}
		return [];
	},

	// Up to 50 websites in one step. A company that is refused is reported with the reason and
	// the rest go on; a refusal about the account stops the step at once.
	async addCompanies(ctx, i) {
		const id = text(ctx.getNodeParameter('campaignId', i));
		const raw = ctx.getNodeParameter('websites', i, '') as unknown;
		const given = Array.isArray(raw) ? raw.map(text) : text(raw).split(/[\s,;]+/);
		const list = [...new Set(given.map(bare).filter(Boolean))];
		if (!list.length) throw new NodeOperationError(ctx.getNode(), 'No website was given.', { itemIndex: i });
		if (list.length > MOST) {
			throw new NodeOperationError(ctx.getNode(), `At most ${MOST} companies at a time. ${list.length} were given.`, { itemIndex: i });
		}
		const rows: IDataObject[] = [];
		for (const website of list) {
			try {
				const a = await call(ctx, 'POST', `/campaigns/${id}/targets`, { url: website });
				rows.push({ website: a.domain ?? website, campaign_id: id, added: true, id: a.target_id ?? a.id ?? null, state: a.state ?? 'pending', reason: null });
			} catch (e) {
				const status = statusOf(e);
				if (!(e instanceof NodeApiError) || (status !== null && (STOPS.includes(status) || status >= 500))) {
					const done = rows.filter((r) => r.added === true).length;
					throw new NodeOperationError(ctx.getNode(), `${(e as Error).message} ${done} of ${list.length} companies were added before this.`, { itemIndex: i });
				}
				rows.push({ website, campaign_id: id, added: false, id: null, state: null, reason: (e as Error).message });
			}
		}
		return rows;
	},

	// One page of the company register. Each company returned is paid for, so the limit is the most it can cost.
	async searchRegister(ctx, i) {
		const country = (text(ctx.getNodeParameter('registerCountry', i, 'PL')) || 'PL').toUpperCase();
		const qs: IDataObject = { limit: Math.min(100, Math.max(1, Number(ctx.getNodeParameter('limit', i, 50)) || 50)) };
		const trade = text(ctx.getNodeParameter('trade', i, ''));
		const place = text(ctx.getNodeParameter('place', i, ''));
		const q = text(ctx.getNodeParameter('nameContains', i, ''));
		const has = text(ctx.getNodeParameter('hasWebsite', i, 'any'));
		const after = text(ctx.getNodeParameter('after', i, ''));
		if (trade) qs.trade = trade;
		if (place) qs.place = place;
		if (q) qs.q = q;
		if (has === 'yes') qs.has_website = true;
		if (has === 'no') qs.has_website = false;
		if (ctx.getNodeParameter('newOnly', i, false) === true) qs.new_to_us = true;
		if (after) qs.after = after;
		const page = await call(ctx, 'GET', `/${country}/companies`, undefined, qs, REGISTRY);
		const next = page.has_more === true ? (page.next_after ?? null) : null;
		return rowsOf(page, 'companies').map((c) => ({
			register_id: c.register_id, country_code: page.country_code ?? country, name: c.name, website: c.website ?? null,
			town: c.town ?? null, region: c.region ?? null, postcode: c.postcode ?? null, street: c.street ?? null,
			activity: c.activity ?? null, activity_text: c.activity_text ?? null, legal_form: c.legal_form ?? null,
			tax_id: c.tax_id ?? null, registered_on: c.registered_on ?? null, active: c.active ?? null, next_after: next,
		}));
	},

	// Asks for the website of one register company. It does not wait: a search still running comes back as queued or working.
	async findWebsite(ctx, i) {
		const country = (text(ctx.getNodeParameter('registerCountry', i, 'PL')) || 'PL').toUpperCase();
		const id = text(ctx.getNodeParameter('registerId', i));
		const asked = await call(ctx, 'POST', `/${country}/companies/${encodeURIComponent(id)}/website`, undefined, undefined, REGISTRY);
		const job = (asked.job ?? {}) as IDataObject;
		return [{
			job_id: job.id ?? null, register_id: job.register_id ?? id, country_code: job.country_code ?? country,
			state: job.state ?? null, found: job.state === 'found', website: job.website ?? null,
		}];
	},
};

export class ContactFormOutreach implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Contact Form Outreach',
		name: 'contactFormOutreach',
		icon: 'file:contactformoutreach.svg',
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Send a business message to companies through their website contact forms',
		defaults: { name: 'Contact Form Outreach' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL, required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'campaign',
				options: [
					{ name: 'Campaign', value: 'campaign' },
					{ name: 'Company', value: 'company' },
					{ name: 'Company Register', value: 'register' },
					{ name: 'Message', value: 'message' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['campaign'] } },
				default: 'createCampaign',
				options: [
					{ name: 'Create', value: 'createCampaign', action: 'Create a campaign', description: 'Starts an empty campaign for your own list of companies. Nothing is sent until you use Send Campaign.' },
					{ name: 'Find', value: 'findCampaign', action: 'Find a campaign', description: 'Finds a campaign by its name' },
					{ name: 'Send', value: 'sendCampaign', action: 'Send a campaign', description: 'Sends the message to every company on the campaign that has a contact form. You pay only for messages that are sent.' },
					{ name: 'Stop', value: 'stopCampaign', action: 'Stop a campaign', description: 'Stops a campaign. A message already on its way may still arrive.' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['company'] } },
				default: 'addCompany',
				options: [
					{ name: 'Add Companies to Campaign', value: 'addCompanies', action: 'Add companies to a campaign', description: 'Adds up to 50 company websites to a campaign in one step. Each company comes back with whether it was added, and why not if it was not.' },
					{ name: 'Add Company to Campaign', value: 'addCompany', action: 'Add a company to a campaign', description: 'Adds one company website to a campaign. Its contact form is looked for right away.' },
					{ name: 'Find Company on Campaign', value: 'findCompany', action: 'Find a company on a campaign', description: 'Finds a company on a campaign by its website, with what happened to it' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['register'] } },
				default: 'searchRegister',
				options: [
					{ name: 'Find Company Website', value: 'findWebsite', action: 'Find the website of a register company', description: 'Finds the website of one company from the company register. A website that is found has its own price, charged once. The API key needs the registry website permission. If the search is still running, the state is queued or working: run the step again later.' },
					{ name: 'Search Company Register', value: 'searchRegister', action: 'Search the company register', description: 'Finds companies in the official company register by trade, place and name. Each company returned has its own price.' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['message'] } },
				default: 'createMessage',
				options: [
					{ name: 'Create', value: 'createMessage', action: 'Create a message', description: 'Writes the message that is sent to companies, with who it is from' },
				],
			},
			{
				displayName: 'Campaign Name or ID',
				name: 'campaignId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getCampaigns' },
				default: '',
				required: true,
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: forOps(...CAMPAIGN_OPS),
			},
			{ displayName: 'Company Website', name: 'website', type: 'string', default: '', required: true, placeholder: 'example.com', displayOptions: forOps('addCompany', 'findCompany') },
			{
				displayName: 'Company Websites',
				name: 'websites',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				placeholder: 'example.com, example.org',
				description: 'Up to 50 websites, separated by commas, spaces or new lines. A list from an earlier step works too.',
				displayOptions: forOps('addCompanies'),
			},
			{
				displayName: 'Register Country Name or ID',
				name: 'registerCountry',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getRegisterCountries' },
				default: 'PL',
				required: true,
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: forOps(...REGISTER_OPS),
			},
			{ displayName: 'Trade', name: 'trade', type: 'string', default: '', placeholder: '25.62', description: 'Activity codes from the register, separated by commas. A division such as 25, a group such as 25.6, or a class such as 25.62.', displayOptions: forOps('searchRegister') },
			{ displayName: 'Place', name: 'place', type: 'string', default: '', description: 'A region or a town, as the register writes it', displayOptions: forOps('searchRegister') },
			{ displayName: 'Name Contains', name: 'nameContains', type: 'string', default: '', description: 'Part of the company name. It needs a trade or a place with it.', displayOptions: forOps('searchRegister') },
			{
				displayName: 'Has a Website',
				name: 'hasWebsite',
				type: 'options',
				default: 'any',
				options: [
					{ name: 'Any', value: 'any' },
					{ name: 'No', value: 'no' },
					{ name: 'Yes', value: 'yes' },
				],
				displayOptions: forOps('searchRegister'),
			},
			{ displayName: 'Only Companies New to You', name: 'newOnly', type: 'boolean', default: false, description: 'Whether to leave out companies you were already given', displayOptions: forOps('searchRegister') },
			{ displayName: 'Limit', name: 'limit', type: 'number', typeOptions: { minValue: 1, maxValue: 100 }, default: 50, description: 'Max number of results to return', displayOptions: forOps('searchRegister') },
			{ displayName: 'Continue After', name: 'after', type: 'string', default: '', description: 'To get the next page, put the Next After value of the page before. Leave empty for the first page.', displayOptions: forOps('searchRegister') },
			{ displayName: 'Register ID', name: 'registerId', type: 'string', default: '', required: true, description: 'The Register ID of the company, as Search Company Register gives it', displayOptions: forOps('findWebsite') },
			{ displayName: 'Name', name: 'name', type: 'string', default: '', required: true, displayOptions: forOps('createMessage', 'createCampaign', 'findCampaign') },
			{
				displayName: 'Message Name or ID',
				name: 'templateId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getMessages' },
				default: '',
				required: true,
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: forOps('createCampaign'),
			},
			{ displayName: 'Country', name: 'country', type: 'string', default: 'PL', required: true, description: 'Two letters, for example PL', displayOptions: forOps('createCampaign') },
			{ displayName: 'Subject', name: 'subject', type: 'string', default: '', required: true, displayOptions: forOps('createMessage') },
			{ displayName: 'Message', name: 'message', type: 'string', typeOptions: { rows: 6 }, default: '', required: true, displayOptions: forOps('createMessage') },
			{ displayName: 'Your Company', name: 'senderCompany', type: 'string', default: '', required: true, displayOptions: forOps('createMessage') },
			{ displayName: 'Your First Name', name: 'senderFirstName', type: 'string', default: '', required: true, displayOptions: forOps('createMessage') },
			{ displayName: 'Your Last Name', name: 'senderLastName', type: 'string', default: '', required: true, displayOptions: forOps('createMessage') },
			{ displayName: 'Your Email', name: 'senderEmail', type: 'string', placeholder: 'name@email.com', default: '', required: true, description: 'Companies answer to this address', displayOptions: forOps('createMessage') },
			{ displayName: 'Your Phone', name: 'senderPhone', type: 'string', default: '', displayOptions: forOps('createMessage') },
			{ displayName: 'Your Website', name: 'senderWebsite', type: 'string', default: '', displayOptions: forOps('createMessage') },
			{ displayName: 'Send at Most', name: 'maxMessages', type: 'number', typeOptions: { minValue: 0 }, default: 0, description: 'Leave at 0 to send to every company that can be reached', displayOptions: forOps('sendCampaign') },
			{
				displayName: 'I Confirm',
				name: 'confirm',
				type: 'boolean',
				default: false,
				description: 'Whether you sign the short statement Contact Form Outreach asks for before it sends: that this is a business enquiry and that you may contact these companies. Turning this on signs it for this campaign.',
				displayOptions: forOps('sendCampaign'),
			},
		],
	};

	methods = {
		loadOptions: {
			async getCampaigns(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const page = await call(this, 'GET', '/campaigns', undefined, { limit: 200 });
				return rowsOf(page, 'campaigns').map((c) => ({ name: text(c.name) || text(c.id), value: text(c.id) }));
			},
			async getRegisterCountries(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const page = await call(this, 'GET', '', undefined, undefined, REGISTRY);
				return rowsOf(page, 'countries')
					.filter((c) => c.enabled !== false)
					.map((c) => ({ name: text(c.name) || text(c.country_code), value: text(c.country_code) }));
			},
			async getMessages(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const page = await call(this, 'GET', '/templates');
				return rowsOf(page, 'templates').map((t) => ({ name: text(t.name) || text(t.id), value: text(t.id) }));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const out: INodeExecutionData[] = [];
		const items = this.getInputData();
		for (let i = 0; i < items.length; i++) {
			try {
				const run = operations[this.getNodeParameter('operation', i) as string];
				if (!run) throw new NodeOperationError(this.getNode(), 'This operation is not known.', { itemIndex: i });
				for (const json of await run(this, i)) out.push({ json, pairedItem: { item: i } });
			} catch (e) {
				if (!this.continueOnFail()) {
					if (e instanceof NodeApiError) throw new NodeApiError(this.getNode(), e as unknown as JsonObject, { itemIndex: i });
					throw new NodeOperationError(this.getNode(), e as Error, { itemIndex: i });
				}
				out.push({ json: { error: (e as Error).message }, pairedItem: { item: i } });
			}
		}
		return [out];
	}
}
