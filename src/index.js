export class ChecklistState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // =====================================================
  // STORAGE
  // =====================================================

  async getDataset() {
    return (
      await this.state.storage.get('dataset')
    ) || null;
  }

  async getTicks() {
    return (
      await this.state.storage.get('ticks')
    ) || {};
  }

  // =====================================================
  // ROW KEY
  // =====================================================

  rowKey(row) {
    const str = row
      .map(
        c =>
          String(c ?? '')
            .trim()
            .toLowerCase()
      )
      .join('|');

    let h = 0;

    for (
      let i = 0;
      i < str.length;
      i++
    ) {
      h =
        (
          Math.imul(31, h)
          +
          str.charCodeAt(i)
        )
        |
        0;
    }

    return (
      'r'
      +
      (h >>> 0).toString(36)
    );
  }

  // =====================================================
  // BUILD CSV REPORT
  // =====================================================

  async buildCsv() {
    const dataset =
      await this.getDataset();

    const ticks =
      await this.getTicks();

    if (!dataset) {
      return '';
    }

    const escapeCsv =
      value => {

        const text =
          String(value ?? '');

        if (
          /[",\n]/.test(text)
        ) {
          return (
            '"'
            +
            text.replace(
              /"/g,
              '""'
            )
            +
            '"'
          );
        }

        return text;
      };

    const seen = {};

    const lines = [];

    // Add report columns
    lines.push(
      [
        ...dataset.headers,
        'Status',
        'Checked date'
      ]
        .map(escapeCsv)
        .join(',')
    );

    dataset.rows.forEach(
      row => {

        const base =
          this.rowKey(row);

        seen[base] =
          (seen[base] || 0)
          +
          1;

        const key =
          seen[base] > 1
            ?
            base
            +
            'd'
            +
            seen[base]
            :
            base;

        const tick =
          ticks[key]
          ||
          {
            checked: false,
            date: ''
          };

        lines.push(
          [
            ...row,

            tick.checked
              ?
              'Checked'
              :
              'Not checked',

            tick.date || ''
          ]
            .map(escapeCsv)
            .join(',')
        );

      }
    );

    return lines.join('\r\n');
  }

  // =====================================================
  // MAILJET EMAIL
  // =====================================================

  async sendReportEmail() {

    // -----------------------------------------
    // Recipient
    // -----------------------------------------

    const recipients =
      (
        this.env.REPORT_RECIPIENTS
        ||
        ''
      )
        .split(',')
        .map(
          email =>
            email.trim()
        )
        .filter(Boolean);

    if (
      !recipients.length
    ) {
      return {
        ok: false,

        error:
          'No REPORT_RECIPIENTS configured'
      };
    }


    // -----------------------------------------
    // Mailjet credentials
    // -----------------------------------------

    const apiKey =
      this.env.MAILJET_API_KEY;

    const secretKey =
      this.env.MAILJET_SECRET_KEY;


    if (!apiKey) {
      return {
        ok: false,

        error:
          'MAILJET_API_KEY is not configured'
      };
    }


    if (!secretKey) {
      return {
        ok: false,

        error:
          'MAILJET_SECRET_KEY is not configured'
      };
    }


    // -----------------------------------------
    // Build CSV
    // -----------------------------------------

    const csv =
      await this.buildCsv();


    const csvBytes =
      new TextEncoder()
        .encode(csv);


    let binary =
      '';


    for (
      let i = 0;
      i < csvBytes.length;
      i++
    ) {
      binary +=
        String.fromCharCode(
          csvBytes[i]
        );
    }


    const base64Csv =
      btoa(binary);


    // -----------------------------------------
    // Basic Authentication
    //
    // Mailjet:
    // username = API Key
    // password = Secret Key
    // -----------------------------------------

    const auth =
      btoa(
        apiKey
        +
        ':'
        +
        secretKey
      );


    // -----------------------------------------
    // Recipient objects
    // -----------------------------------------

    const mailjetRecipients =
      recipients.map(
        email => ({
          Email: email
        })
      );


    // -----------------------------------------
    // Send through Mailjet
    // -----------------------------------------

    const response =
      await fetch(
        'https://api.mailjet.com/v3.1/send',
        {
          method: 'POST',

          headers: {
            'Authorization':
              'Basic ' + auth,

            'Content-Type':
              'application/json'
          },

          body:
            JSON.stringify({
              Messages: [
                {
                  From: {
                    Email:
                      'ontheroadrivein@gmail.com',

                    Name:
                      'Code Tubes'
                  },

                  To:
                    mailjetRecipients,

                  Subject:
                    'Code Tubes — checklist report',

                  TextPart:
                    'Attached is the current Code Tubes checklist report.',

                  HTMLPart:
                    `
                      <h2>Code Tubes</h2>

                      <p>
                        Attached is the current
                        Code Tubes checklist report.
                      </p>

                      <p>
                        The CSV contains both
                        completed and pending items.
                      </p>
                    `,

                  Attachments: [
                    {
                      ContentType:
                        'text/csv',

                      Filename:
                        'code-tubes-report.csv',

                      Base64Content:
                        base64Csv
                    }
                  ]
                }
              ]
            })
        }
      );


    // -----------------------------------------
    // Mailjet response
    // -----------------------------------------

    const responseText =
      await response
        .text()
        .catch(
          () => ''
        );


    if (
      !response.ok
    ) {
      return {
        ok: false,

        error:
          'Mailjet API error ('
          +
          response.status
          +
          '): '
          +
          responseText
      };
    }


    // Mailjet can return HTTP success while
    // containing detailed message information.

    let responseData =
      null;


    try {
      responseData =
        JSON.parse(
          responseText
        );
    } catch (err) {}


    return {
      ok: true,

      response:
        responseData
    };
  }


  // =====================================================
  // DURABLE OBJECT ROUTES
  // =====================================================

  async fetch(request) {

    const url =
      new URL(request.url);

    try {

      // =================================================
      // GET /state
      //
      // Full spreadsheet + checks.
      // Called when the page loads.
      // =================================================

      if (
        url.pathname === '/state'
        &&
        request.method === 'GET'
      ) {

        const dataset =
          await this.getDataset();

        const ticks =
          await this.getTicks();


        return json({
          headers:
            dataset
              ?
              dataset.headers
              :
              [],

          rows:
            dataset
              ?
              dataset.rows
              :
              [],

          tickColIndex:
            dataset
              ?
              dataset.tickColIndex
              :
              -1,

          ticks
        });
      }


      // =================================================
      // POST /dataset
      //
      // Store or replace the spreadsheet.
      // =================================================

      if (
        url.pathname === '/dataset'
        &&
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


        // New spreadsheet =
        // fresh checklist.

        await this.state.storage.put(
          'ticks',
          {}
        );


        return json({
          ok: true
        });
      }


      // =================================================
      // POST /tick
      //
      // Save one checkbox.
      // =================================================

      if (
        url.pathname === '/tick'
        &&
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
              ?
              new Date()
                .toLocaleDateString(
                  'en-US'
                )
              :
              ''
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


      // =================================================
      // POST /reset
      //
      // Clear all checkmarks.
      // =================================================

      if (
        url.pathname === '/reset'
        &&
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


      // =================================================
      // POST /send-report
      //
      // Manual report.
      //
      // Can be sent with:
      // 0%, 20%, 50%, 100%...
      //
      // No completion requirement.
      // =================================================

      if (
        url.pathname === '/send-report'
        &&
        request.method === 'POST'
      ) {

        const dataset =
          await this.getDataset();


        if (
          !dataset
          ||
          !dataset.rows
          ||
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


        if (
          !result.ok
        ) {

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


      // =================================================
      // NOT FOUND
      // =================================================

      return json(
        {
          error:
            'not found'
        },
        404
      );

    }

    catch (err) {

      return json(
        {
          error:
            String(
              err
              &&
              err.message
                ?
                err.message
                :
                err
            )
        },
        500
      );
    }
  }
}


// =====================================================
// JSON RESPONSE HELPER
// =====================================================

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


// =====================================================
// MAIN CLOUDFLARE WORKER
// =====================================================

export default {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(request.url);


    // -------------------------------------------------
    // API
    // -------------------------------------------------

    if (
      url.pathname.startsWith(
        '/api/'
      )
    ) {

      // Keep one fixed Durable Object.
      //
      // Do not change "singleton".
      // Otherwise Cloudflare would use
      // a different storage instance.

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


      const forwardRequest =
        new Request(
          forwardUrl.toString(),
          request
        );


      return stub.fetch(
        forwardRequest
      );
    }


    // -------------------------------------------------
    // STATIC WEBSITE
    // -------------------------------------------------

    return env.ASSETS.fetch(
      request
    );
  }
};
