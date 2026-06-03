/**
 * Check Jenkins for currently running pipelines and send a status email.
 * Triggered via GitHub Actions workflow_dispatch when someone announces a build in Teams.
 */

const https    = require('node:https');
const nodemailer = require('nodemailer');

const JENKINS_BASE   = 'jenkins.ckdigital.in';
const JENKINS_FOLDER = '/job/CADP_AKS/job/DEV/job';
const JENKINS_USER   = process.env.JENKINS_USER;
const JENKINS_PASS   = process.env.JENKINS_PASS;
const GMAIL_USER     = process.env.GMAIL_USER_PIPELINE;
const GMAIL_PASS     = process.env.GMAIL_APP_PASSWORD_PIPELINE;
const RECIPIENT      = 'hemanth.a@hepl.com';
const TRIGGERED_BY   = process.env.TRIGGERED_BY || 'Teams message';

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

function jenkinsGet(urlPath) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${JENKINS_USER}:${JENKINS_PASS}`).toString('base64');
    const req = https.request({
      hostname: JENKINS_BASE, path: urlPath, method: 'GET',
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function checkJob(job) {
  const res = await jenkinsGet(
    `${JENKINS_FOLDER}/${job}/lastBuild/api/json?tree=number,building,result,actions[parameters[name,value]]`
  );
  if (res.status !== 200) return null;
  try {
    const d = JSON.parse(res.body);
    const envParam = (d.actions || []).flatMap(a => a.parameters || []).find(p => p.name === 'ENV');
    return {
      job,
      number:   d.number,
      building: d.building,
      result:   d.result,
      env:      envParam?.value?.toUpperCase() || 'DEV',
    };
  } catch { return null; }
}

async function main() {
  console.log('Checking Jenkins running pipelines...');
  const results = await Promise.all(JOBS.map(checkJob));
  const valid   = results.filter(Boolean);
  const running = valid.filter(r => r.building);
  const count   = running.length;

  console.log(`Running pipelines: ${count}`);
  running.forEach(r => console.log(`  - [${r.env}] ${r.job} #${r.number}`));

  const runningRows = running.map(r => `
    <tr>
      <td style="padding:10px 16px;font-weight:600">${r.job}</td>
      <td style="padding:10px 16px;text-align:center">
        <span style="background:#fef3c7;color:#92400e;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600">${r.env}</span>
      </td>
      <td style="padding:10px 16px;text-align:center">#${r.number}</td>
      <td style="padding:10px 16px;text-align:center">
        <span style="background:#dcfce7;color:#166534;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600">&#9654; RUNNING</span>
      </td>
    </tr>`).join('');

  const statusColor = count === 0 ? '#166534' : '#b45309';
  const statusBg    = count === 0 ? '#dcfce7' : '#fef3c7';
  const statusText  = count === 0
    ? '&#10003; All pipelines are free &mdash; safe to start your build'
    : `&#9888; ${count} pipeline${count > 1 ? 's are' : ' is'} currently running &mdash; wait before starting`;

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:680px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1)">
    <div style="background:#1e3a5f;padding:24px 32px">
      <h1 style="margin:0;color:#fff;font-size:20px">&#128269; Jenkins Pipeline Status</h1>
      <p style="margin:6px 0 0;color:#93c5fd;font-size:13px">Triggered by: <em>${TRIGGERED_BY}</em></p>
    </div>

    <div style="padding:20px 32px;background:${statusBg};border-bottom:1px solid #e5e7eb;">
      <p style="margin:0;font-size:15px;font-weight:700;color:${statusColor}">${statusText}</p>
    </div>

    <div style="padding:24px 32px">
      <p style="font-size:14px;color:#374151;margin:0 0 16px;">
        <strong>${count}</strong> of <strong>${JOBS.length}</strong> pipelines currently running:
      </p>
      ${count > 0 ? `
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px">
        <thead>
          <tr style="background:#1e3a5f">
            <th style="padding:10px 16px;color:#fff;text-align:left">Job</th>
            <th style="padding:10px 16px;color:#fff;text-align:center">Env</th>
            <th style="padding:10px 16px;color:#fff;text-align:center">Build #</th>
            <th style="padding:10px 16px;color:#fff;text-align:center">Status</th>
          </tr>
        </thead>
        <tbody>${runningRows}</tbody>
      </table>` : '<p style="color:#166534;font-size:14px;">No pipelines running &mdash; Jenkins is all yours!</p>'}
    </div>
    <div style="padding:16px 32px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">
      This is an automated Jenkins status check triggered by a Teams message.
    </div>
  </div>`;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });

  await transporter.sendMail({
    from:    `"CADP Pipeline Manager" <${GMAIL_USER}>`,
    to:      RECIPIENT,
    subject: `[Jenkins STATUS] ${count} pipeline${count !== 1 ? 's' : ''} running — ${count === 0 ? 'Safe to build' : 'Wait before building'}`,
    html,
  });

  console.log('Status email sent.');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
