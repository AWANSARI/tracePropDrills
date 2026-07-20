// Webview-side renderer for the trace tree. Plain DOM, no framework.
// Strict CSP: this file is loaded with a nonce and never uses inline
// handlers or innerHTML (all text goes through textContent).
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const content = document.getElementById('content');

  const KIND_LABEL = {
    selection: 'target',
    'state-hook': 'state',
    hook: 'hook',
    'local-variable': 'local',
    import: 'import',
    'from-parent-prop': 'parent prop',
    'received-param': 'param',
    'props-access': 'props',
    're-passed-prop': 're-pass',
    'component-definition': 'component',
    unresolved: 'unresolved',
  };

  document.getElementById('btn-refresh').addEventListener('click', function () {
    vscode.postMessage({ type: 'refresh' });
  });
  document.getElementById('btn-clear').addEventListener('click', function () {
    vscode.setState(undefined);
    renderEmpty('Trace cleared.');
  });

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (message.type === 'render') {
      vscode.setState({ result: message.result });
      renderResult(message.result);
    } else if (message.type === 'status') {
      renderEmpty(message.text);
    } else if (message.type === 'clear') {
      vscode.setState(undefined);
      renderEmpty('Trace cleared.');
    }
  });

  // Restore the last tree after the webview is re-created (e.g. window reload).
  const previous = vscode.getState();
  if (previous && previous.result) {
    renderResult(previous.result);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function renderEmpty(text) {
    content.textContent = '';
    content.appendChild(
      el('div', 'empty', text || 'Place the cursor on a prop and run "Trace Prop at Cursor".')
    );
  }

  function renderResult(result) {
    content.textContent = '';
    content.appendChild(renderNode(result.root));
    if (result.warnings && result.warnings.length > 0) {
      const box = el('div', 'warnings');
      for (const warning of result.warnings) {
        box.appendChild(el('div', 'warning', '⚠ ' + warning));
      }
      content.appendChild(box);
    }
  }

  function baseName(filePath) {
    return filePath.split(/[\\/]/).pop();
  }

  function renderNode(node) {
    const wrap = el('div', 'node');
    const row = el('div', 'row');
    const hasChildren = node.children.length > 0;

    const twisty = el('span', hasChildren ? 'twisty' : 'twisty leaf', hasChildren ? '▾' : '');
    row.appendChild(twisty);
    row.appendChild(el('span', 'badge k-' + node.kind, KIND_LABEL[node.kind] || node.kind));
    row.appendChild(el('span', 'label', node.label));
    if (node.valueText) {
      row.appendChild(el('code', 'value', '= ' + node.valueText));
    }
    if (node.unresolvedReason) {
      row.appendChild(el('span', 'reason', node.unresolvedReason));
    }
    row.appendChild(
      el('span', 'file', baseName(node.location.filePath) + ':' + (node.location.line + 1))
    );
    if (node.snippet) {
      row.appendChild(el('div', 'snippet', node.snippet));
    }

    row.addEventListener('click', function () {
      vscode.postMessage({ type: 'reveal', location: node.location });
    });
    if (hasChildren) {
      twisty.addEventListener('click', function (event) {
        event.stopPropagation();
        const collapsed = wrap.classList.toggle('collapsed');
        twisty.textContent = collapsed ? '▸' : '▾';
      });
    }

    wrap.appendChild(row);

    if (hasChildren) {
      const children = el('div', 'children');
      if (node.kind === 'selection') {
        // Group the top level of a selection into the two halves of the trace.
        const upstream = node.children.filter(function (c) { return c.direction === 'upstream'; });
        const downstream = node.children.filter(function (c) { return c.direction === 'downstream'; });
        const other = node.children.filter(function (c) {
          return c.direction !== 'upstream' && c.direction !== 'downstream';
        });
        if (upstream.length > 0) {
          children.appendChild(section('Origin ↑', upstream));
        }
        if (downstream.length > 0) {
          children.appendChild(section('Flows into ↓', downstream));
        }
        for (const child of other) {
          children.appendChild(renderNode(child));
        }
      } else {
        for (const child of node.children) {
          children.appendChild(renderNode(child));
        }
      }
      wrap.appendChild(children);
    }
    return wrap;
  }

  function section(title, nodes) {
    const box = el('div', 'section');
    box.appendChild(el('div', 'section-title', title));
    for (const node of nodes) {
      box.appendChild(renderNode(node));
    }
    return box;
  }
})();
