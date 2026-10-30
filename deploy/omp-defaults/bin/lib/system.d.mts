export declare const IS_WINDOWS: boolean;
export declare function run(command: string, args: string[], timeout?: number, partial?: boolean): string | undefined;
export declare function projectListeners(root: string): { port: number; pid: number; cmd: string }[];
export declare function projectRoot(cwd?: string): string;
