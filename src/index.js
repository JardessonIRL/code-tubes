
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

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/state' && request.method === 'GET') {
      const dataset = await this.getDataset();
      const ticks = await this.getTicks();

      return json({
        headers: dataset ? dataset.headers : [],
        rows: dataset ? dataset.rows : [],
        tickColIndex: dataset ? dataset.tickColIndex : -1,
        ticks
      });
    }

    if (url.pathname === '/dataset' && request.method === 'POST') {
      const body = await request.json();

      await this.state.storage.put('dataset', {
        headers: body.headers,
        rows: body.rows,
        tickColIndex: body.tickColIndex
      });

      await this.state.storage.put('ticks', {});
      return json({ ok: true });
    }

    if (url.pathname === '/tick' && request.method === 'POST') {
      const body = await request.json();
      const ticks = await this.getTicks();

      ticks[body.key] = {
        checked: !!body.checked,
        date: body.checked ? new Date().toLocaleDateString('en-US') : ''
      };

      await this.state.storage.put('ticks', ticks);
      return json({ ok: true, tick: ticks[body.key] });
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      await this.state.storage.put('ticks', {});
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const id = env.CHECKLIST.idFromName('singleton');
      const stub = env.CHECKLIST.get(id);

      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = url.pathname.slice('/api'.length) || '/';

      return stub.fetch(new Request(forwardUrl.toString(), request));
    }

    return env.ASSETS.fetch(request);
  }
};
