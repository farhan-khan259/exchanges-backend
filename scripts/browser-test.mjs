import {spawn} from 'node:child_process';import {MongoMemoryReplSet} from 'mongodb-memory-server';
if(!process.env.KHATA_CHROMIUM)throw new Error('Set KHATA_CHROMIUM to a Chromium executable');
const replica=await MongoMemoryReplSet.create({binary:{version:'7.0.14'},replSet:{count:1,storageEngine:'wiredTiger',args:['--nounixsocket']}});
try{const child=spawn(process.execPath,['--import','tsx','--test','tests/browser-offline.test.ts'],{stdio:'inherit',env:{...process.env,NODE_ENV:'test',TEST_MONGODB_URI:replica.getUri('browser_test'),APP_ORIGIN:'http://localhost:5174'}});process.exitCode=await new Promise(r=>child.on('exit',r));}finally{await replica.stop();}
