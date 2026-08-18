export declare const name: string;
export declare const inject: string[];
export declare function confirmHighRisk(ctx: any, args: any): Promise<{ok: boolean, confirmed?: boolean, reason?: string}>;
export declare function apply(ctx: any): void;
