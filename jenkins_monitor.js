/**
 * Jenkins CI/CD Monitor
 * Polls all jobs across environments, detects new pass/fail, sends email.
 * State is persisted in jenkins_state.json (committed back to repo).
 */

const https      = require('node:https');
const http       = require('node:http');
const nodemailer = require('nodemailer');
const fs         = require('node:fs');
const path       = require('node:path');

const JENKINS_BASE  = 'jenkins.ckdigital.in';
const JENKINS_USER  = process.env.JENKINS_USER;
const JENKINS_PASS  = process.env.JENKINS_PASS;
const GMAIL_USER    = process.env.GMAIL_USER_PIPELINE;
const GMAIL_PASS    = process.env.GMAIL_APP_PASSWORD_PIPELINE;
const RECIPIENT     = 'hemanth.a@hepl.com';
const STATE_FILE    = path.join(__dirname, 'jenkins_state.json');

// Add QA/UAT here when those folders are created in Jenkins
const ENVIRONMENTS = [
  { name: 'DEV', folder: '/job/CADP_AKS/job/DEV/job' },
  // { name: 'QA',  folder: '/job/CADP_AKS/job/QA/job' },
  // { name: 'UAT', folder: '/job/CADP_AKS/job/UAT/job' },
];

const JOBS = [
  'cadp-chat-backend',
  'CADP_Client_WS_backend',
  'CADP_Client_WS_Metadata_Backend_Node',
  'CADP_master_backend_nodejs',
  'cadp_notification_backend_nodejs',
  'CADP_platform_backend_nodejs',
  'CADP_RBAC_backend_nodejs',
  'Cadp_template_backend_nodejs',
  'cadp_workflow_backend_nodejs',
  'Cadp-portal',
];

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function jenkinsGet(urlPath) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${JENKINS_USER}:${JENKINS_PASS}`).toString('base64');
    const options = {
      hostname: JENKINS_BASE,
      path: urlPath,
      method: 'GET',
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      rejectUnauthorized: false,
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function getLastBuild(folder, job) {
  const res = await jenkinsGet(`${folder}/${job}/lastBuild/api/json?tree=number,building,result,timestamp`);
  if (res.status !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

async function getStages(folder, job, buildNumber) {
  const res = await jenkinsGet(`${folder}/${job}/${buildNumber}/wfapi/describe`);
  if (res.status !== 200) return [];
  try { return JSON.parse(res.body).stages || []; } catch { return []; }
}

async function getConsoleText(folder, job, buildNumber) {
  const res = await jenkinsGet(`${folder}/${job}/${buildNumber}/consoleText`);
  return res.body || '';
}


// ── State management ──────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Email ─────────────────────────────────────────────────────────────────────

async function sendSuccessEmail(env, job, buildNumber) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  await transporter.sendMail({
    from:    `"CADP Pipeline Manager" <${GMAIL_USER}>`,
    to:      RECIPIENT,
    subject: `[Jenkins ${env}] [SUCCESS] ${job} #${buildNumber}`,
    html: `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1)">
      <div style="background:#166534;padding:24px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px">&#9989; Jenkins Build Passed</h1>
        <p style="margin:6px 0 0;color:#bbf7d0;font-size:14px">${job} &mdash; Build #${buildNumber} &mdash; <strong>${env}</strong></p>
      </div>
      <div style="padding:24px 32px">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr style="background:#f3f4f6"><td style="padding:10px 16px;font-weight:600;width:160px">Environment</td><td style="padding:10px 16px;font-weight:700;color:#166534;">${env}</td></tr>
          <tr><td style="padding:10px 16px;font-weight:600">Job</td><td style="padding:10px 16px">${job}</td></tr>
          <tr style="background:#f3f4f6"><td style="padding:10px 16px;font-weight:600">Build #</td><td style="padding:10px 16px">${buildNumber}</td></tr>
          <tr><td style="padding:10px 16px;font-weight:600">Result</td><td style="padding:10px 16px;color:#16a34a;font-weight:700">&#9989; SUCCESS</td></tr>
        </table>
      </div>
      <div style="padding:16px 32px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">This is an automated Jenkins build notification.</div>
    </div>`,
  });
  console.log(`  &#9989; Success email sent for [${env}] ${job} #${buildNumber}`);
}

async function sendFailureEmail(env, job, buildNumber, failedStage, consoleText) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });

  const isImageStageFail = failedStage.toLowerCase().includes('build application image');
  const subject = `[Jenkins ${env}] [FAILED] ${job} #${buildNumber} &mdash; ${failedStage}`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:700px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1)">
      <div style="background:#b91c1c;padding:24px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px">❌ Jenkins Build Failed</h1>
        <p style="margin:6px 0 0;color:#fecaca;font-size:14px">${job} &mdash; Build #${buildNumber} &mdash; <strong>${env}</strong></p>
      </div>
      <div style="padding:24px 32px">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr style="background:#f3f4f6">
            <td style="padding:10px 16px;font-weight:600;width:160px">Environment</td>
            <td style="padding:10px 16px;font-weight:700;color:#b91c1c;">${env}</td>
          </tr>
          <tr>
            <td style="padding:10px 16px;font-weight:600">Job</td>
            <td style="padding:10px 16px">${job}</td>
          </tr>
          <tr style="background:#f3f4f6">
            <td style="padding:10px 16px;font-weight:600">Build #</td>
            <td style="padding:10px 16px">${buildNumber}</td>
          </tr>
          <tr style="background:#f3f4f6">
            <td style="padding:10px 16px;font-weight:600">Failed Stage</td>
            <td style="padding:10px 16px;color:#b91c1c;font-weight:700">${failedStage}</td>
          </tr>
          <tr>
            <td style="padding:10px 16px;font-weight:600">Type</td>
            <td style="padding:10px 16px">${isImageStageFail ? '🔴 Image build failure — pipeline stopped' : '🟡 Post-image stage failure'}</td>
          </tr>
        </table>
        <p style="margin-top:20px;font-size:13px;color:#6b7280">Full console output is attached. Check the Jenkins link for details.</p>
      </div>
      <div style="padding:16px 32px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">
        This is an automated Jenkins build failure notification.
      </div>
    </div>`;

  await transporter.sendMail({
    from:    `"CADP Pipeline Manager" <${GMAIL_USER}>`,
    to:      RECIPIENT,
    subject,
    html,
    attachments: [{
      filename:    `${job}_#${buildNumber}_console.txt`,
      content:     consoleText,
      contentType: 'text/plain',
    }],
  });

  console.log(`  ✅ Failure email sent for ${job} #${buildNumber} (stage: ${failedStage})`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const state = loadState();
  let stateChanged = false;

  for (const { name: env, folder } of ENVIRONMENTS) {
    console.log(`\nChecking [${env}]...`);

    for (const job of JOBS) {
      const stateKey = `${env}:${job}`;
      const build = await getLastBuild(folder, job);
      if (!build) { console.log(`  ${job}: could not fetch`); continue; }
      if (build.building) { console.log(`  ${job}: #${build.number} still running`); continue; }

      if (build.result !== 'FAILURE') {
        const lastChecked = state[stateKey]?.lastChecked || 0;
        if (build.number > lastChecked && build.result === 'SUCCESS') {
          await sendSuccessEmail(env, job, build.number);
        }
        state[stateKey] = { lastChecked: build.number, lastResult: build.result };
        stateChanged = true;
        console.log(`  ${job}: #${build.number} ${build.result}`);
        continue;
      }

      // It's a FAILURE — check if we already notified
      const lastNotified = state[stateKey]?.lastNotified || 0;
      if (build.number <= lastNotified) {
        console.log(`  ${job}: #${build.number} FAILURE (already notified)`);
        continue;
      }

      // New failure — find which stage failed
      console.log(`  ${job}: #${build.number} NEW FAILURE — fetching stages...`);
      const stages      = await getStages(folder, job, build.number);
      const failedStage = stages.find(s => s.status === 'FAILED');
      const stageName   = failedStage?.name || 'Unknown Stage';
      const consoleText = await getConsoleText(folder, job, build.number);

      await sendFailureEmail(env, job, build.number, stageName, consoleText);

      state[stateKey] = { lastNotified: build.number, lastChecked: build.number, lastResult: 'FAILURE' };
      stateChanged = true;
    }
  }

  if (stateChanged) saveState(state);
  console.log('\nDone.');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
