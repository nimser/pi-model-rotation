#!/usr/bin/env node
import { opencodeUrl, saveSession } from "../src/opencode.ts";

const given = process.argv.slice(2).join("").trim();
if (!given) {
	console.error(`Sign in at ${opencodeUrl()}/auth, then copy the value of the "auth" cookie for ${opencodeUrl()}:`);
	console.error(`  ${process.argv[1]} <cookie>`);
	process.exit(1);
}
console.log(`opencode session stored at ${saveSession(given)}`);
