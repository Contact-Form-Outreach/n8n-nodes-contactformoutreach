import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class ContactFormOutreachApi implements ICredentialType {
	name = 'contactFormOutreachApi';

	displayName = 'Contact Form Outreach API';

	icon: Icon = 'file:../nodes/ContactFormOutreach/contactformoutreach.svg';

	documentationUrl = 'https://api.cadgentic.com/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Make a key in Contact Form Outreach under Settings, API keys (https://app.contactformoutreach.com/settings/api-keys). Give it the read, write and webhooks permissions.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
	};

	test: ICredentialTestRequest = {
		request: { baseURL: 'https://api.cadgentic.com/v1/cfs', url: '/me' },
	};
}
