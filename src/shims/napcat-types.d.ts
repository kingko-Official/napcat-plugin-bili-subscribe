declare module 'napcat-types/napcat-onebot' {
    export interface OB11Message {
        post_type: string;
        message_type: 'group' | 'private' | string;
        raw_message?: string;
        group_id?: number | string;
        user_id?: number | string;
        sender?: {
            role?: string;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    }

    export interface OB11PostSendMsg {
        message: string | Array<{ type: string; data: Record<string, unknown> }>;
        message_type: string;
        group_id?: string;
        user_id?: string;
    }
}

declare module 'napcat-types/napcat-onebot/network/plugin/types' {
    export type PluginLogger = {
        debug: (...args: unknown[]) => void;
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
    };

    export type PluginConfigSchema = unknown[];

    export interface PluginHttpRequest {
        body?: unknown;
        query?: Record<string, unknown>;
        params?: Record<string, string>;
    }

    export interface PluginHttpResponse {
        status: (code: number) => PluginHttpResponse;
        json: (body: unknown) => void;
    }

    export interface NapCatPluginContext {
        pluginName: string;
        dataPath: string;
        configPath: string;
        adapterName: string;
        logger: PluginLogger;
        pluginManager: { config: unknown };
        actions: {
            call: (action: never, params: never, adapterName: string, config: unknown) => Promise<unknown>;
        };
        router: {
            static: (urlPath: string, directory: string) => void;
            page: (page: {
                path: string;
                title: string;
                htmlFile: string;
                description?: string;
            }) => void;
            getNoAuth: (
                path: string,
                handler: (req: PluginHttpRequest, res: PluginHttpResponse) => void | Promise<void>,
            ) => void;
            postNoAuth: (
                path: string,
                handler: (req: PluginHttpRequest, res: PluginHttpResponse) => void | Promise<void>,
            ) => void;
        };
        NapCatConfig: {
            combine: (...items: unknown[]) => PluginConfigSchema;
            html: (content: string) => unknown;
            boolean: (
                key: string,
                label: string,
                defaultValue?: boolean,
                description?: string,
                reactive?: boolean,
            ) => unknown;
            text: (
                key: string,
                label: string,
                defaultValue?: string,
                description?: string,
                reactive?: boolean,
            ) => unknown;
            number: (
                key: string,
                label: string,
                defaultValue?: number,
                description?: string,
                reactive?: boolean,
            ) => unknown;
        };
    }

    export interface PluginModule {
        plugin_init: (ctx: NapCatPluginContext) => Promise<void> | void;
        plugin_onmessage: (ctx: NapCatPluginContext, event: import('napcat-types/napcat-onebot').OB11Message) => Promise<void> | void;
        plugin_onevent: (ctx: NapCatPluginContext, event: unknown) => Promise<void> | void;
        plugin_cleanup: (ctx: NapCatPluginContext) => Promise<void> | void;
        plugin_get_config: (ctx: NapCatPluginContext) => Promise<unknown> | unknown;
        plugin_set_config: (ctx: NapCatPluginContext, config: unknown) => Promise<void> | void;
        plugin_on_config_change: (
            ctx: NapCatPluginContext,
            ui: unknown,
            key: string,
            value: unknown,
            currentConfig: unknown,
        ) => Promise<void> | void;
    }
}
