import os from 'node:os';
import path from 'node:path';

/** Must equal manifest.json `name`: CloudCLI keys plugin secrets and RPC routes by it. */
export const PLUGIN_NAME = 'coagent';

/** State lives outside the plugin folder so reinstalling the plugin keeps it. */
export const DATA_DIR = process.env.COAGENT_DATA_DIR ?? path.join(os.homedir(), '.cloudcli-coagent');
export const DB_FILE = path.join(DATA_DIR, 'coagent.db');
/** Written by the broker on start: { port, token, pid }. Read by the MCP shim on every call. */
export const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
