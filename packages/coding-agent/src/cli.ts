#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
process.title = "clanker";

import { bedrockProviderModule } from "@mariozechner/clanker-ai/bedrock-provider";
import { setBedrockProviderModule } from "@mariozechner/clanker-ai";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { main } from "./main.js";

setGlobalDispatcher(new EnvHttpProxyAgent());
setBedrockProviderModule(bedrockProviderModule);

main(process.argv.slice(2));
