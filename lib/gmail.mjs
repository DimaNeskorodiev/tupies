// Gmail (https://developers.google.com/gmail/api/reference/rest) as a declared REST integration with OAuth 2.0 sign-in.
// It is an ordinary owner-approved integration: the owner creates a Google OAuth client and signs in; every call needs
// approval of its exact arguments. A bot can propose the same definition itself with integration_propose; the
// acceptance test builds its proposal from this module with the endpoints pointed at a local fixture.
// Scope: https://www.googleapis.com/auth/gmail.modify alone. The label action needs it, and it already includes reading and
// sending, so gmail.readonly and gmail.send would add nothing. Permanent deletion (https://mail.google.com/) is left out.

export const GMAIL_API='https://gmail.googleapis.com';
export const GOOGLE_AUTHORIZATION_URL='https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL='https://oauth2.googleapis.com/token';
export const GMAIL_MODIFY_SCOPE='https://www.googleapis.com/auth/gmail.modify';
export const GMAIL_FULL_SCOPE='https://mail.google.com/';
const MESSAGES='/gmail/v1/users/me/messages';
const id={type:'string',minLength:1,maxLength:200,description:'Message id from search_messages.'};
const labels=description=>({type:'array',maxItems:20,items:{type:'string',minLength:1,maxLength:200},description});

export const GMAIL_SETUP_NOTES='1. In Google Cloud Console (console.cloud.google.com) create or pick a project. 2. APIs & Services → Library: enable the Gmail API. 3. OAuth consent screen: choose External (or Internal for Workspace), add your own address as a test user, and add the scope https://www.googleapis.com/auth/gmail.modify. 4. Credentials → Create credentials → OAuth client ID → Web application; under Authorised redirect URIs add the return address Tupies shows on the connect card. 5. Copy the client ID and client secret into Tupies, then press Sign in. While the app is in Testing, Google ends the sign-in after 7 days; sign in again or publish the app.';

/** The declared actions: search and read (GET), send and change labels (POST). Delete is optional and off by default. */
export function gmailActions({remove=false}={}) {
  return [
    {name:'search_messages',description:'Find messages with Gmail search syntax (q, for example from:anna newer_than:7d is:unread). Returns message ids; read each with read_message.',method:'GET',path:`${MESSAGES}`,inputSchema:{type:'object',properties:{q:{type:'string',maxLength:500},maxResults:{type:'integer',minimum:1,maximum:50},labelIds:labels('Only messages with all of these label ids, such as INBOX or UNREAD.'),pageToken:{type:'string',maxLength:500}},additionalProperties:false}},
    {name:'read_message',description:'Read one message: headers and body text (text parts are decoded). Attachments stay as data.',method:'GET',path:`${MESSAGES}/{id}`,decode:{keys:['data'],as:'base64url'},inputSchema:{type:'object',properties:{id,format:{type:'string',enum:['full','metadata','minimal']}},required:['id'],additionalProperties:false}},
    {name:'send_message',description:'Send one email. raw is the whole message in RFC 822 form: To:, Subject: and Content-Type: text/plain; charset=UTF-8 header lines, an empty line, then the body.',method:'POST',path:`${MESSAGES}/send`,encode:{raw:'base64url'},inputSchema:{type:'object',properties:{raw:{type:'string',minLength:1,maxLength:100000},threadId:{type:'string',maxLength:200}},required:['raw'],additionalProperties:false}},
    {name:'modify_labels',description:'Add or remove label ids on one message, for example remove UNREAD to mark it read or INBOX to archive it.',method:'POST',path:`${MESSAGES}/{id}/modify`,inputSchema:{type:'object',properties:{id,addLabelIds:labels('Label ids to add.'),removeLabelIds:labels('Label ids to remove.')},required:['id'],additionalProperties:false}},
    ...(remove?[{name:'delete_message',description:'Permanently delete one message. It cannot be recovered; prefer removing the INBOX label.',method:'DELETE',path:`${MESSAGES}/{id}`,inputSchema:{type:'object',properties:{id},required:['id'],additionalProperties:false}}]:[]),
  ];
}

/** A complete Gmail definition. Endpoints default to Google's; tests point them at a local fixture. */
export function gmailDefinition({baseUrl=GMAIL_API,authorizationUrl=GOOGLE_AUTHORIZATION_URL,tokenUrl=GOOGLE_TOKEN_URL,remove=false}={}) {
  return {name:'Gmail',type:'rest',baseUrl,authType:'oauth2',
    oauth:{authorizationUrl,tokenUrl,scopes:[GMAIL_MODIFY_SCOPE,...(remove?[GMAIL_FULL_SCOPE]:[])],extraParams:{access_type:'offline',prompt:'consent'}},
    tools:gmailActions({remove}),setupNotes:GMAIL_SETUP_NOTES};
}

/** The Settings → Integrations preset. */
export function gmailPreset() {
  return {id:'gmail',...gmailDefinition(),description:'Search, read and send mail and change labels in your Gmail account. You create a Google OAuth client once; each action still asks for approval.'};
}
