-- Graph assigns conversationId PER MAILBOX — the same physical email cc'd to
-- both contactus@sariahfm.com and maintenance@sariahfm.com gets a different
-- conversationId in each mailbox's copy, so conversation_id alone can't
-- detect that duplicate (confirmed: two real rows, same subject/timestamp,
-- different conversation_id, different mailbox_owner_id). internetMessageId
-- is the RFC5322 Message-ID header — stable across every mailbox that
-- receives a copy of the same physical message — verified identical on a
-- real cross-mailbox duplicate pair before adding this.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS internet_message_id text;
CREATE INDEX IF NOT EXISTS idx_emails_internet_message_id ON emails (internet_message_id);
