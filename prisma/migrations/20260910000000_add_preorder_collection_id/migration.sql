-- Replaces the previously hardcoded preorder collection ID with per-shop
-- configuration. Existing rows get NULL, which the app treats as
-- "preorder collection sync disabled" until a merchant picks a collection.
ALTER TABLE "ShopSettings" ADD COLUMN "preorderCollectionId" TEXT;
