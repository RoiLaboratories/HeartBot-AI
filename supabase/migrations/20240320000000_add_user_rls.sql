-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can read their own data" ON "User";
DROP POLICY IF EXISTS "Users can insert their own data" ON "User";
DROP POLICY IF EXISTS "Users can update their own data" ON "User";

-- Enable RLS on User table
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;

-- Create policy to allow users to read their own data
CREATE POLICY "Users can read their own data"
ON "User"
FOR SELECT
USING (auth.uid()::text = telegram_id);

-- Create policy to allow users to insert their own data
CREATE POLICY "Users can insert their own data"
ON "User"
FOR INSERT
WITH CHECK (auth.uid()::text = telegram_id);

-- Create policy to allow users to update their own data
CREATE POLICY "Users can update their own data"
ON "User"
FOR UPDATE
USING (auth.uid()::text = telegram_id)
WITH CHECK (auth.uid()::text = telegram_id); 