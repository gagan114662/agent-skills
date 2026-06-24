ALTER TABLE messages
  ADD CONSTRAINT messages_body_length_ck CHECK (char_length(body) <= 65536);

