import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { baseUrl, runWithRequest } from "../src/context";

// Resolve through the actual consuming package, including nested SDK copies.
const projectRequire = createRequire(__filename);
const expressRequire = createRequire(projectRequire.resolve("express/package.json"));
const sdkRequire = createRequire(projectRequire.resolve("stremio-addon-sdk/package.json"));
const routerRequire = createRequire(sdkRequire.resolve("router/package.json"));
const inquirerRequire = createRequire(sdkRequire.resolve("inquirer/package.json"));
const editorRequire = createRequire(inquirerRequire.resolve("external-editor/package.json"));

test("IPv6 trust ranges do not accidentally trust arbitrary IPv4 peers", () => {
  const proxyaddr = expressRequire("proxy-addr");
  for (const subnet of ["::ffff:10.0.0.0/8", "::/1"]) {
    const trust = proxyaddr.compile(subnet);
    assert.equal(trust("203.0.113.10", 0), false);
  }
  const correct = proxyaddr.compile("::ffff:10.0.0.0/104");
  assert.equal(correct("10.1.2.3", 0), true);
  assert.equal(correct("203.0.113.10", 0), false);
});

test("untrusted HTTP clients cannot forge IP, TLS state or generated origins", async () => {
  const saved = process.env.BASE_URL;
  delete process.env.BASE_URL;
  const app = express();
  app.set("trust proxy", "192.0.2.0/24");
  app.get("/", (req, res) => runWithRequest(req, () => res.json({ ip: req.ip, secure: req.secure, base: baseUrl() })));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(origin, { headers: { "X-Forwarded-For": "198.51.100.7", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "evil.invalid" } });
    assert.deepEqual(await response.json(), { ip: "127.0.0.1", secure: false, base: origin });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (saved === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = saved;
  }
});

test("compressed JSON with trailing bytes cannot crash the parser process", () => {
  // An affected parser can kill its process asynchronously; isolate the probe.
  const output = execFileSync(process.execPath, ["-e", `
    const assert=require('node:assert/strict');
    const express=require(process.argv[1]);
    const {gzipSync}=require('node:zlib');
    const app=express(); app.use(express.json());
    app.post('/',(req,res)=>res.json({ok:true}));
    app.get('/health',(req,res)=>res.end('alive'));
    app.use((error,req,res,next)=>res.status(400).end('invalid body'));
    const server=app.listen(0,'127.0.0.1',async()=>{
      try {
        const base='http://127.0.0.1:'+server.address().port;
        const body=Buffer.concat([gzipSync(Buffer.from('{"owned":true}')),Buffer.from('trailing bytes')]);
        const response=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json','Content-Encoding':'gzip'},body});
        assert.ok([200,400].includes(response.status)); await response.text();
        await new Promise(resolve=>setTimeout(resolve,50));
        assert.equal(await (await fetch(base+'/health')).text(),'alive');
        process.stdout.write('survived');
      } catch(error) { process.exitCode=1; }
      finally { server.close(); }
    });
  `, projectRequire.resolve("express")], { timeout: 10000, encoding: "utf8" });
  assert.equal(output, "survived");
});

test("SDK route matcher rejects adversarial multi-parameter input within a bounded process", () => {
  execFileSync(process.execPath, ["-e", `
    const assert=require('node:assert/strict');
    const compile=require(process.argv[1]);
    const route=compile('/:a-:b-:c');
    assert.equal(route.test('/'+'a-'.repeat(10000)+'a/b'),false);
  `, routerRequire.resolve("path-to-regexp")], { timeout: 5000, stdio: "pipe" });
});

test("query serialization handles a shadowed non-callable toString without crashing", () => {
  const qs = expressRequire("qs");
  const serialized = qs.stringify({ a: [{ toString: "owned fixture" }] }, { arrayFormat: "comma" });
  assert.equal(serialized, "a=%5Bobject%20Object%5D");
  assert.equal(qs.stringify({ a: ["one", "two"] }, { arrayFormat: "comma" }), "a=one%2Ctwo");
});

test("SDK temporary-file dependency refuses traversal while preserving editor compatibility", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "subsync-tmp-security-"));
  const base = path.join(directory, "base");
  fs.mkdirSync(base);
  const tmp = editorRequire("tmp");
  try {
    assert.throws(() => tmp.fileSync({ tmpdir: base, prefix: "../escaped" }));
    const editor = new (inquirerRequire("external-editor").ExternalEditor)("Owned editor fixture");
    const file = editor.tempFile as string;
    try {
      assert.equal(fs.readFileSync(file, "utf8"), "Owned editor fixture");
    } finally { editor.cleanup(); }
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
