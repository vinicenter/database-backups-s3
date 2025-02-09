require('dotenv').config();
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const s3 = require("@aws-sdk/client-s3");
const fs = require('fs');
const cron = require("cron");

function loadConfig() {
  const requiredEnvars = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_S3_REGION',
    'AWS_S3_ENDPOINT',
    'AWS_S3_BUCKET'
  ];

  for (const key of requiredEnvars) {
    if (!process.env[key]) {
      throw new Error(`Environment variable ${key} is required`);
    }
  }

  return {
    aws: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_S3_REGION,
      endpoint: process.env.AWS_S3_ENDPOINT,
      s3_bucket: process.env.AWS_S3_BUCKET
    },
    databases: process.env.DATABASES ? process.env.DATABASES.split(",") : [],
    run_on_startup: process.env.RUN_ON_STARTUP === 'true' ? true : false,
    notify: {
      telegram: {
        isEnabled: !!process.env.TELEGRAM_TOKEN,
        token: process.env.TELEGRAM_TOKEN,
        chatIds: process.env.TELEGRAM_CHAT_IDS ? process.env.TELEGRAM_CHAT_IDS.split(",") : [],
      }
    },
    cron: process.env.CRON,
  };
}

const config = loadConfig();

const s3Client = new s3.S3Client(config.aws);

async function processBackup() {
  if (config.databases.length === 0) {
    console.log("No databases defined.");
    return;
  }

  for (const [index, databaseURI] of config.databases.entries()) {
    const databaseIteration = index + 1;
    const totalDatabases = config.databases.length;

    const url = new URL(databaseURI);
    const dbType = url.protocol.slice(0, -1); // remove trailing colon
    const dbName = url.pathname.substring(1); // extract db name from URL
    const dbHostname = url.hostname;
    const dbUser = url.username;
    const dbPassword = url.password;
    const dbPort = url.port;

    const date = new Date();
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    const timestamp = `${yyyy}-${mm}-${dd}_${hh}:${min}:${ss}`;
    const filename = `backup-${dbType}-${timestamp}-${dbName}-${dbHostname}.tar.gz`;
    const filepath = `/tmp/${filename}`;

    const startBackupMessage = `\n[${databaseIteration}/${totalDatabases}] ${dbType}/${dbName} Backup in progress...`
    await notifyTelegram(startBackupMessage);
    console.log(startBackupMessage)

    let dumpCommand;
    switch (dbType) {
      case 'postgresql':
        dumpCommand = `pg_dump "${databaseURI}" -F c > "${filepath}.dump"`;
        break;
      case 'mongodb':
        dumpCommand = `mongodump --uri="${databaseURI}" --archive="${filepath}.dump"`;
        break;
      case 'mysql':
        dumpCommand = `mysqldump -u ${dbUser} -p${dbPassword} -h ${dbHostname} -P ${dbPort} ${dbName} > "${filepath}.dump"`;
        break;
      default:
        console.log(`Unknown database type: ${dbType}`);
        return;
    }

    try {
      // 1. Execute the dump command
      await exec(dumpCommand);

      // 2. Compress the dump file
      await exec(`tar -czvf ${filepath} ${filepath}.dump`);

      // 3. Read the compressed file
      const data = fs.readFileSync(filepath);

      // 4. Upload to S3
      const params = {
        Bucket: config.aws.s3_bucket,
        Key: filename,
        Body: data
      };

      const putCommand = new s3.PutObjectCommand(params);
      await s3Client.send(putCommand);

      const message = `✓ Successfully uploaded db backup for database ${dbType} ${dbName} ${dbHostname}.`;

      await notifyTelegram(message);
      console.log(`✓ Successfully uploaded db backup for database ${dbType} ${dbName} ${dbHostname}.`);
    } catch (error) {
      const message = `✗ An error occurred while processing the database ${dbType} ${dbName}, host: ${dbHostname}): ${error}`;
      await notifyTelegram(message);
      console.error(message);
    }
  }
}

async function notifyTelegram(message) {
  try {
    if (!config.notify.telegram.isEnabled) {
      console.log("Telegram notifications are disabled. Define TELEGRAM_TOKEN and TELEGRAM_CHAT_IDS to enable.");
  
      return;
    }
  
    const chatIds = config.notify.telegram.chatIds;
  
    if (!chatIds.length) {
      console.log("No chat IDs defined for Telegram notifications. Define TELEGRAM_CHAT_IDS to enable.");
  
      return;
    }

    const newMessage = `[eGesto Backup Database] ${message}`;
  
    for (const chatId of chatIds) {
      const url = `https://api.telegram.org/bot${config.notify.telegram.token}/sendMessage?chat_id=${chatId}&text=${newMessage}`;
      await fetch(url);
    }
  } catch(e) {
    console.error("An error occurred while sending Telegram notification.", e);
  }
}

if (config.cron) {
  const CronJob = cron.CronJob;
  const job = new CronJob(config.cron, processBackup);
  job.start();

  console.log(`Backups configured on Cron job schedule: ${config.cron}`);
}

if (config.run_on_startup) {
  console.log("run_on_startup enabled, backing up now...")
  processBackup();
}
