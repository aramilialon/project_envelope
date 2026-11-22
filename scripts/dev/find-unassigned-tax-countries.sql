-- Lists the workspaces whose tax country is not an officially assigned ISO 3166-1 alpha-2 code
-- (#711), such as "ZZ", "EU" or "UN". The API refuses those since #711 (`invalid_tax_country`),
-- but a database written before that may still hold some. Such a workspace keeps working, as one
-- with a country that has no tax rules: only `IT` has any today. Its owner sets a valid code, or
-- none, with `PATCH /workspaces/:workspaceId` (docs/portfolio-api.md, "Workspace tax country").
--
-- The list below is `ISO_3166_1_ALPHA2_CODES` from packages/core/src/country.ts;
-- apps/api/src/routes/workspaces.test.ts checks that the two agree.
--
-- Read-only. Run it as the table owner (the `envelope` role, DATABASE_URL), which Row-Level
-- Security does not restrict, so it sees every workspace:
--
--   psql "$DATABASE_URL" -f scripts/dev/find-unassigned-tax-countries.sql
--
-- No rows means there is nothing to fix.

SELECT w.id AS workspace_id,
       w.name,
       w.tax_country
FROM workspaces w
WHERE w.tax_country IS NOT NULL
  AND NOT (w.tax_country = ANY ('{
  AD,AE,AF,AG,AI,AL,AM,AO,AQ,AR,AS,AT,AU,AW,AX,AZ,BA,BB,BD,BE,BF,BG,BH,BI,
  BJ,BL,BM,BN,BO,BQ,BR,BS,BT,BV,BW,BY,BZ,CA,CC,CD,CF,CG,CH,CI,CK,CL,CM,CN,
  CO,CR,CU,CV,CW,CX,CY,CZ,DE,DJ,DK,DM,DO,DZ,EC,EE,EG,EH,ER,ES,ET,FI,FJ,FK,
  FM,FO,FR,GA,GB,GD,GE,GF,GG,GH,GI,GL,GM,GN,GP,GQ,GR,GS,GT,GU,GW,GY,HK,HM,
  HN,HR,HT,HU,ID,IE,IL,IM,IN,IO,IQ,IR,IS,IT,JE,JM,JO,JP,KE,KG,KH,KI,KM,KN,
  KP,KR,KW,KY,KZ,LA,LB,LC,LI,LK,LR,LS,LT,LU,LV,LY,MA,MC,MD,ME,MF,MG,MH,MK,
  ML,MM,MN,MO,MP,MQ,MR,MS,MT,MU,MV,MW,MX,MY,MZ,NA,NC,NE,NF,NG,NI,NL,NO,NP,
  NR,NU,NZ,OM,PA,PE,PF,PG,PH,PK,PL,PM,PN,PR,PS,PT,PW,PY,QA,RE,RO,RS,RU,RW,
  SA,SB,SC,SD,SE,SG,SH,SI,SJ,SK,SL,SM,SN,SO,SR,SS,ST,SV,SX,SY,SZ,TC,TD,TF,
  TG,TH,TJ,TK,TL,TM,TN,TO,TR,TT,TV,TW,TZ,UA,UG,UM,US,UY,UZ,VA,VC,VE,VG,VI,
  VN,VU,WF,WS,YE,YT,ZA,ZM,ZW
}'::text[]))
ORDER BY w.id;
