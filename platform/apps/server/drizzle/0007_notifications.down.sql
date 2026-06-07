-- Reverse of 0007_notifications.
DROP TABLE IF EXISTS notification_preferences;
DROP INDEX IF EXISTS notifications_unread_idx;
DROP INDEX IF EXISTS notifications_recipient_idx;
DROP TABLE IF EXISTS notifications;
