export HOME="$TMPDIR" ADB_DATA_DIR="$TMPDIR/data"
runHook preCheck
eval "\"\$launcher\" --non-interactive $sets"
shopt -s nullglob
cards=("$ADB_DATA_DIR"/runs/*/*/run.json)
test "${#cards[@]}" -eq 1
python -c 'import json, sys; assert json.load(open(sys.argv[1]))["lifecycle"]["state"] == "completed", "smoke: run did not complete"' "${cards[0]}"
adb-runner verify "${cards[0]%/run.json}" --data-dir "$ADB_DATA_DIR" --manifest "$manifest"
runHook postCheck
touch "$out"
