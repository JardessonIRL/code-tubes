export class ChecklistState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async getDataset() {
    return (await this.state.storage.get('dataset')) || null;
  }

  async getTicks() {
    return (await this.state.storage.get('ticks')) || {};
  }

  rowKey(row) {
    const str = row
      .map(c => String(c ?? '').trim().toLowerCase())
      .join('|');

    let h = 0;

    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }

    return 'r' + (h >>> 0).toString(36);
  }

  async buildCsv() {
    const dataset = await this.getDataset();
    const ticks = await this.getTicks();

    if (!dataset) {
      return '';
    }

    const escapeCsv = value => {
      const text = String(value ?? '');

      return /[",\n]/.test(text)
        ? '"' + text.replace(/"/g, '""') + '"'
        : text;
    };

    const seen = {};
    const lines = [];

    lines.push(
      [...dataset.headers, 'Status', 'Checked date']
        .map(escapeCsv)
        .join(',')
    );

    dataset.rows.forEach(row => {
      const base = this.rowKey(row);

      seen[base] =
        (seen[base] || 0) + 1;

      const key =
        seen[base] > 1
          ? base + 'd' + seen[base]
          : base;

      const tick =
        ticks[key] || {
          checked: false,
          date: ''
        };

      lines.push(
        [
          ...row,
          tick.checked
            ? 'Checked'
            : 'Not checked',
          tick.date || ''
        ]
          .map(escapeCsv)
          .join(',')
      );
    });

    return lines.join('\r\n');
  }

  async getResendApiKey() {
    const binding =
      this.env.RESEND_API_KEY;

    if (!binding) {
      return null;
    }

    // Cloudflare Secrets Store
    if (
      typeof binding.get === 'function'
    ) {
      return await binding.get();
    }

    // Fallback if configured as
    // a normal Worker Secret.
    if (
      typeof binding === 'string'
    ) {
      return binding;
    }

    return null;
  }

  async sendReportEmail() {
    const csv =
      await this.buildCsv();

    const recipients =
      (
        this.env.REPORT_RECIPIENTS
        ||
        ''
      )
        .split(',')
        .map(email =>
          email.trim()
        )
        .filter(Boolean);

    if (!recipients.length) {
      return {
        ok: false,
        error:
          'No REPORT_RECIPIENTS configured'
      };
    }

    const apiKey =
      await this.getResendApiKey();

    if (!apiKey) {
      return {
        ok: false,
        error:
          'No RESEND_API_KEY configured'
      };
    }

    const bytes =
      new TextEncoder()
        .encode(csv);

    let binary = '';

    for (
      let i = 0;
      i < bytes.length;
      i++
    ) {
      binary +=
        String.fromCharCode(
          bytes[i]
        );
    }

    const base64 =
      btoa(binary);

    const response =
      await fetch(
        'https://api.resend.com/emails',
        {
          method: 'POST',

          headers: {
            'Authorization':
              'Bearer ' + apiKey,

            'content-type':
              'application/json'
          },

          body: JSON.stringify({
            from:
              'Code Tubes <onboarding@resend.dev>',

            to:
              recipients,

            subject:
              'Code Tubes — checklist report',

            text:
              'Attached is the current Code Tubes checklist report.',

            attachments: [
              {
                filename:
                  'code-tubes-report.csv',

                content:
                  base64
              }
            ]
          })
        }
      );

    if (!response.ok) {
      const errorText =
        await response
          .text()
          .catch(() => '');

      return {
        ok: false,

        error:
          'Resend API error (' +
          response.status +
          '): ' +
          errorText
      };
    }

    return {
      ok: true
    };
  }

  async fetch(request) {
    const url =
      new URL(request.url);

    try {

      // =========================================
      // GET /state
      // =========================================

      if (
        url.pathname === '/state' &&
        request.method === 'GET'
      ) {
        const dataset =
          await this.getDataset();

        const ticks =
          await this.getTicks();

        return json({
          headers:
            dataset
              ? dataset.headers
              : [],

          rows:
            dataset
              ? dataset.rows
              : [],

          tickColIndex:
            dataset
              ? dataset.tickColIndex
              : -1,

          ticks
        });
      }

      // =========================================
      // POST /dataset
      // =========================================

      if (
        url.pathname === '/dataset' &&
        request.method === 'POST'
      ) {
        const body =
          await request.json();

        await this.state.storage.put(
          'dataset',
          {
            headers:
              body.headers,

            rows:
              body.rows,

            tickColIndex:
              body.tickColIndex
          }
        );

        // New sheet starts fresh
        await this.state.storage.put(
          'ticks',
          {}
        );

        return json({
          ok: true
        });
      }

      // =========================================
      // POST /tick
      // =========================================

      if (
        url.pathname === '/tick' &&
        request.method === 'POST'
      ) {
        const body =
          await request.json();

        const ticks =
          await this.getTicks();

        ticks[body.key] = {
          checked:
            !!body.checked,

          date:
            body.checked
              ? new Date()
                  .toLocaleDateString(
                    'en-US'
                  )
              : ''
        };

        await this.state.storage.put(
          'ticks',
          ticks
        );

        return json({
          ok: true,

          tick:
            ticks[body.key]
        });
      }

      // =========================================
      // POST /reset
      // =========================================

      if (
        url.pathname === '/reset' &&
        request.method === 'POST'
      ) {
        await this.state.storage.put(
          'ticks',
          {}
        );

        return json({
          ok: true
        });
      }

      // =========================================
      // POST /send-report
      //
      // Can be used at any moment.
      // =========================================

      if (
        url.pathname === '/send-report' &&
        request.method === 'POST'
      ) {
        const dataset =
          await this.getDataset();

        if (
          !dataset ||
          !dataset.rows ||
          !dataset.rows.length
        ) {
          return json(
            {
              ok: false,

              error:
                'No spreadsheet is currently loaded'
            },
            400
          );
        }

        const result =
          await this.sendReportEmail();

        if (!result.ok) {
          return json(
            {
              ok: false,

              error:
                result.error
            },
            502
          );
        }

        return json({
          ok: true,
          sent: true
        });
      }

      return json(
        {
          error:
            'not found'
        },
        404
      );

    } catch (err) {

      return json(
        {
          error:
            String(
              err &&
              err.message
                ? err.message
                : err
            )
        },
        500
      );
    }
  }
}


function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        'content-type':
          'application/json'
      }
    }
  );
}


// =============================================
// MAIN WORKER
// =============================================

export default {
  async fetch(
    request,
    env
  ) {
    const url =
      new URL(request.url);

    if (
      url.pathname.startsWith(
        '/api/'
      )
    ) {
      const id =
        env.CHECKLIST
          .idFromName(
            'singleton'
          );

      const stub =
        env.CHECKLIST
          .get(id);

      const forwardUrl =
        new URL(
          request.url
        );

      forwardUrl.pathname =
        url.pathname.slice(
          '/api'.length
        )
        ||
        '/';

      const forwardReq =
        new Request(
          forwardUrl.toString(),
          request
        );

      return stub.fetch(
        forwardReq
      );
    }

    return env.ASSETS.fetch(
      request
    );
  }
};
