#!/usr/bin/env node
import { awaitDeviceApproval, opencodeAuthPath, requestDeviceCode } from "../src/opencode.ts";

const code = await requestDeviceCode();
console.log(`Approve code ${code.userCode} at ${code.verificationUrl}`);
await awaitDeviceApproval(code);
console.log(`opencode console credential stored at ${opencodeAuthPath()}`);
