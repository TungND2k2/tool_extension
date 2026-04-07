from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

# Same location and format as extension/sessionStore.ts
# ~/.milo/sessions/<id>.jsonl  — one JSON object per line
SESSIONS_DIR = Path.home() / '.milo' / 'sessions'


@dataclass
class SessionMessage:
    role: str                    # 'user' | 'assistant'
    content: list                # Anthropic content blocks
    timestamp: int = field(default_factory=lambda: int(time.time() * 1000))


@dataclass
class SessionMeta:
    session_id: str
    created_at: int
    preview: str = ''
    message_count: int = 0


def _ensure_dir() -> None:
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)


def new_session(session_id: str | None = None) -> str:
    """Create a new .jsonl session file. Returns the session_id."""
    _ensure_dir()
    sid = session_id or uuid.uuid4().hex
    path = SESSIONS_DIR / f'{sid}.jsonl'
    header = {'type': 'session', 'session_id': sid, 'version': 1, 'created_at': int(time.time() * 1000)}
    path.write_text(json.dumps(header) + '\n', encoding='utf-8')
    return sid


def append_message(session_id: str, message: SessionMessage) -> None:
    """Append a message entry to a session file."""
    path = SESSIONS_DIR / f'{session_id}.jsonl'
    if not path.exists():
        new_session(session_id)
    entry = {'type': 'message', 'role': message.role, 'content': message.content, 'timestamp': message.timestamp}
    with path.open('a', encoding='utf-8') as f:
        f.write(json.dumps(entry) + '\n')


def append_tool_result(session_id: str, tool_use_id: str, tool_name: str, output: str, is_error: bool) -> None:
    """Append a tool result entry to a session file."""
    path = SESSIONS_DIR / f'{session_id}.jsonl'
    if not path.exists():
        return
    entry = {
        'type': 'tool_result',
        'tool_use_id': tool_use_id,
        'tool_name': tool_name,
        'output': output[:5000],
        'is_error': is_error,
        'timestamp': int(time.time() * 1000),
    }
    with path.open('a', encoding='utf-8') as f:
        f.write(json.dumps(entry) + '\n')


def load_messages(session_id: str) -> list[SessionMessage]:
    """Load messages from a session file (for resume)."""
    path = SESSIONS_DIR / f'{session_id}.jsonl'
    if not path.exists():
        return []
    messages: list[SessionMessage] = []
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            if entry.get('type') == 'message':
                messages.append(SessionMessage(
                    role=entry['role'],
                    content=entry['content'],
                    timestamp=entry.get('timestamp', 0),
                ))
        except (json.JSONDecodeError, KeyError):
            pass
    return messages


def list_sessions() -> list[SessionMeta]:
    """List all saved sessions, newest first."""
    _ensure_dir()
    metas: list[SessionMeta] = []
    for p in sorted(SESSIONS_DIR.glob('*.jsonl'), key=lambda f: f.stat().st_mtime, reverse=True):
        sid = p.stem
        preview = ''
        count = 0
        created_at = int(p.stat().st_ctime * 1000)
        try:
            for line in p.read_text(encoding='utf-8').splitlines():
                entry = json.loads(line.strip())
                if entry.get('type') == 'session':
                    created_at = entry.get('created_at', created_at)
                elif entry.get('type') == 'message':
                    count += 1
                    if not preview and entry.get('role') == 'user':
                        blocks = entry.get('content', [])
                        for b in blocks:
                            if isinstance(b, dict) and b.get('type') == 'text':
                                preview = b['text'][:80]
                                break
        except (json.JSONDecodeError, OSError):
            pass
        metas.append(SessionMeta(session_id=sid, created_at=created_at, preview=preview, message_count=count))
    return metas


def delete_session(session_id: str) -> None:
    """Delete a session file."""
    path = SESSIONS_DIR / f'{session_id}.jsonl'
    if path.exists():
        path.unlink()


# ── Backward-compat shim for Python CLI (query_engine.py, main.py) ───────────
# query_engine dùng StoredSession(messages=tuple[str,...]) — raw prompt strings,
# không phải Anthropic content blocks. Giữ nguyên luồng đó, chỉ đổi lưu vào
# cùng thư mục ~/.milo/sessions/ thay vì .port_sessions/.

from dataclasses import dataclass as _dc, asdict as _asdict

@_dc(frozen=True)
class StoredSession:
    session_id: str
    messages: tuple          # tuple[str, ...] — raw prompt strings
    input_tokens: int
    output_tokens: int


def save_session(session: StoredSession, directory: Path | None = None) -> Path:
    """Save a CLI porting session. Uses ~/.milo/sessions/ by default."""
    target_dir = directory or SESSIONS_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f'{session.session_id}.cli.json'
    path.write_text(json.dumps(_asdict(session), indent=2), encoding='utf-8')
    return path


def load_session(session_id: str, directory: Path | None = None) -> StoredSession:
    """Load a CLI porting session."""
    target_dir = directory or SESSIONS_DIR
    # Try new location first, fall back to legacy .port_sessions/
    candidates = [
        target_dir / f'{session_id}.cli.json',
        Path('.port_sessions') / f'{session_id}.json',
    ]
    for p in candidates:
        if p.exists():
            data = json.loads(p.read_text(encoding='utf-8'))
            return StoredSession(
                session_id=data['session_id'],
                messages=tuple(data['messages']),
                input_tokens=data['input_tokens'],
                output_tokens=data['output_tokens'],
            )
    raise FileNotFoundError(f'Session not found: {session_id}')
