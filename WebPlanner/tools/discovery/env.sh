# source me
export NASA_API_KEY="$(cat ~/.config/nasa_api_key)"
R=~/coding/hl-discovery/raw
LEDGER=~/coding/hl-discovery/raw/_ledger.tsv
export GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR
fetch() { local u="$1" o="$2" l="${3:-$2}"; local w; w=$(curl -sS -L --compressed -o "$R/$o" -w '%{http_code}\t%{size_download}\t%{size_header}\t%{time_total}' "$u"); printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$l" "$w" "$(echo "$u" | sed -E 's/api_key=[^&]*/api_key=REDACTED/')" >> "$LEDGER"; echo "$w"; }
head_() { local u="$1" l="$2"; local w; w=$(curl -sSI -L "$u" -o "$R/$l.head" -w '%{http_code}\t0\t%{size_header}\t%{time_total}'); printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$l" "$w" "$u" >> "$LEDGER"; echo "$w"; grep -iE '^(HTTP|content-length|last-modified|content-type)' "$R/$l.head"; }
# gnet LABEL cmd... : stdout+stderr of cmd -> $R/LABEL.out ; logs bytes and wall time
gnet() { local l="$1"; shift; local t0=$EPOCHREALTIME; CPL_VSIL_SHOW_NETWORK_STATS=YES "$@" > "$R/$l.out" 2>&1; local rc=$?; local t1=$EPOCHREALTIME; local b; b=$(grep -A8 'Network statistics' "$R/$l.out" | grep -oE '"downloaded_bytes":[0-9]+' | head -1 | cut -d: -f2); local dt; dt=$(python3 -c "print(round($t1-$t0,2))"); printf '%s\t%s\tgdal\t%s\t0\t%s\t-\n' "$(date -u +%FT%TZ)" "$l" "${b:-0}" "$dt" >> "$LEDGER"; echo "rc=$rc bytes=${b:-0} t=${dt}s"; }
total() { awk -F'\t' '{s+=$4+$5} END {printf "%.2f MB\n", s/1e6}' "$LEDGER"; }
