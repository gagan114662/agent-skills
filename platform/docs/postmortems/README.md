# Postmortems

Incident postmortems drafted by the **SRE Loop** (#112, ADR-0112). When an `sre_incidents` row
resolves, the loop drafts a timeline + 5-whys-skeleton markdown here (`<date>-<service>-<slo>-<id>.md`)
via the `PostmortemWriter` seam and records the path on the incident row. The **Founder Console**
(#104) links the recent ones read-only.

These are **drafts** — an agent (or a human) refines the 5-whys and action items. The file's existence
is the durable trace an incident leaves behind; before the SRE Loop, incidents left none.

Generated drafts are committed by the running platform, not by hand. This README is the only
hand-authored file in the directory.
