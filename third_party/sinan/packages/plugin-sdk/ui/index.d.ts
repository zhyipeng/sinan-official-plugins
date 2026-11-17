export function ready(): void;
export function execute(commandId:string,input:string):Promise<{text:string;dismiss?:boolean;keepHidden?:boolean}>;
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

export function readClipboardText():Promise<string>;
export function writeClipboardText(text:string):Promise<null>;

export interface UIImage {url:string;mimeType:string;width:number;height:number;bytes:number}
export function readClipboardImage():Promise<UIImage|null>;
export function executeImage(commandId:string,url:string):Promise<{text:string;dismiss?:boolean;keepHidden?:boolean}>;

export function executeHidden(commandId:string,input?:string):Promise<{text:string;dismiss?:boolean;keepHidden?:boolean}>;

export function showWindow(): Promise<null>;
export function hideWindow(): Promise<null>;
export function savePNG(commandId:string,input:string): Promise<{saved:boolean}>;

export function openImage(): Promise<UIImage|null>;

export interface DependencyStatus {id:string;pluginId:string;state:string;message:string;optional:boolean;minVersion:string}
export function readDependencies():Promise<DependencyStatus[]>;
export function openDependencyManager():Promise<null>;
export function stageDependencyImage(dependency:string,entryId:string,blob:Blob):Promise<string>;
export function openDependency(dependency:string,entryId:string,input:{imageHandle:string}):Promise<null>;
export function discardDependencyImage(imageHandle:string):Promise<null>;
