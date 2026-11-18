This checks the existing DAG continuation path, not model quality. The local
mock used the Sol and Astra model IDs in place of the generic fixture IDs.
The run used OpenCode 2.3.2 and the unchanged DAG on `1d20930`.

To repeat after building the plugin, use a fresh evidence directory:

```sh
cd script
sed -e 's/gpt-a/gpt-6.2-sol/g' -e 's/gpt-b/gpt-6.2-astra/g' qa-owner-rescue.mjs |
  node --input-type=module - ../.iolaus/evidence/gpt62-same-session-repeat
```
