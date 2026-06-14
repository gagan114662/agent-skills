-- Down for 0196_legal_compliance_pack (#196). Drop the six additive tables; nothing else referenced them.
DROP TABLE IF EXISTS data_rights_requests;
DROP TABLE IF EXISTS compliance_events;
DROP TABLE IF EXISTS consent_records;
DROP TABLE IF EXISTS email_suppressions;
DROP TABLE IF EXISTS legal_documents;
DROP TABLE IF EXISTS legal_facts;
