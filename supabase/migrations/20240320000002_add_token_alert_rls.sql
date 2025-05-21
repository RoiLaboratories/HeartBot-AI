-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can read their own token alerts" ON "TokenAlert";
DROP POLICY IF EXISTS "Users can insert their own token alerts" ON "TokenAlert";
DROP POLICY IF EXISTS "Users can update their own token alerts" ON "TokenAlert";
DROP POLICY IF EXISTS "Users can delete their own token alerts" ON "TokenAlert";

-- Enable RLS on TokenAlert table
ALTER TABLE "TokenAlert" ENABLE ROW LEVEL SECURITY;

-- Create policy to allow users to read their own token alerts
CREATE POLICY "Users can read their own token alerts"
ON "TokenAlert"
FOR SELECT
USING (auth.uid()::text = user_id);

-- Create policy to allow users to insert their own token alerts
CREATE POLICY "Users can insert their own token alerts"
ON "TokenAlert"
FOR INSERT
WITH CHECK (auth.uid()::text = user_id);

-- Create policy to allow users to update their own token alerts
CREATE POLICY "Users can update their own token alerts"
ON "TokenAlert"
FOR UPDATE
USING (auth.uid()::text = user_id)
WITH CHECK (auth.uid()::text = user_id);

-- Create policy to allow users to delete their own token alerts
CREATE POLICY "Users can delete their own token alerts"
ON "TokenAlert"
FOR DELETE
USING (auth.uid()::text = user_id); 