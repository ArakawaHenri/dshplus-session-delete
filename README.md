# DSH Plus · Session Delete

English | [中文](README.zh.md)

Permanently delete archived sessions from the DSH sidebar.

Part of [DSH Plus](https://github.com/ArakawaHenri/dshplus) (`@dshplus/session-delete`).

## Install

Install `@dshplus/session-delete` in the DSH Plugin Manager (or install the [`@dshplus/bundle`](https://github.com/ArakawaHenri/dshplus) bundle):

```text
@dshplus/session-delete
```

## Usage

1. Archive the session you want to remove.
2. Open its `…` menu in the archived sessions list and click **Delete permanently…**.
3. Confirm in the dialog to remove the session's JSONL logs and clean up its archive record.

Only archived sessions with no running tasks or active reminders can be deleted. Files in your workspace, uploaded attachments, and history already forked into other sessions are kept.

## License

MIT
