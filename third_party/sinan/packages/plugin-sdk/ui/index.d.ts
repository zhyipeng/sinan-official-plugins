export function ready(): void;
export function execute(commandId:string,input:string):Promise<{text:string;dismiss?:boolean}>;
export function readData<T=unknown>():Promise<{revision:number;value:T|null}>;
export function writeData<T=unknown>(revision:number,value:T):Promise<{revision:number;value:T}>;
export function readLaunch():Promise<{commandId?:string;input?:string;image?:{url:string;mimeType:string;width:number;height:number;bytes:number}}>;

export function pasteToPreviousApp(): Promise<null>;

export function readEncryptedData<T=unknown>():Promise<{revision:number;value:T|null}>;
export function writeEncryptedData<T=unknown>(revision:number,value:T):Promise<{revision:number;value:T}>;

export interface LLMRequest {profileId?:string;systemPrompt:string;input:string}
export function listLLMConfigurations():Promise<{profiles:{id:string;name:string}[];defaultProfile:string}>;
export function startLLM(value:LLMRequest):Promise<{id:string}>;
export function pollLLM(id:string):Promise<{done:boolean;text:string;error:string}>;
export function cancelLLM(id:string):Promise<null>;
