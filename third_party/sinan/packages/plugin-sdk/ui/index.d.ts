export function ready(): void;
export function execute(commandId:string,input:string):Promise<{text:string;dismiss?:boolean}>;
export function readData<T=unknown>():Promise<{revision:number;value:T|null}>;
export function writeData<T=unknown>(revision:number,value:T):Promise<{revision:number;value:T}>;
