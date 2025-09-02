import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { notebookId } = await req.json()

    if (!notebookId) {
      return new Response(
        JSON.stringify({ error: 'Notebook ID is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const diagnostics: any = {
      notebookId,
      timestamp: new Date().toISOString(),
      environment: {},
      notebook: {},
      sources: {},
      vectorStore: {},
      chatHistory: {}
    }

    // Check environment variables
    diagnostics.environment = {
      hasNotebookChatUrl: !!Deno.env.get('NOTEBOOK_CHAT_URL'),
      hasNotebookGenerationAuth: !!Deno.env.get('NOTEBOOK_GENERATION_AUTH'),
      hasSupabaseUrl: !!Deno.env.get('SUPABASE_URL'),
      hasSupabaseServiceKey: !!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      notebookChatUrl: Deno.env.get('NOTEBOOK_CHAT_URL') || 'NOT_SET'
    }

    // Check notebook
    const { data: notebook, error: notebookError } = await supabaseClient
      .from('notebooks')
      .select('*')
      .eq('id', notebookId)
      .single()

    diagnostics.notebook = {
      exists: !!notebook,
      error: notebookError?.message,
      data: notebook
    }

    // Check sources
    const { data: sources, error: sourcesError } = await supabaseClient
      .from('sources')
      .select('id, title, type, processing_status, created_at')
      .eq('notebook_id', notebookId)

    diagnostics.sources = {
      count: sources?.length || 0,
      error: sourcesError?.message,
      statuses: sources?.map(s => ({ id: s.id, title: s.title, status: s.processing_status })),
      hasCompleted: sources?.some(s => s.processing_status === 'completed') || false
    }

    // Check vector store documents
    const { data: documents, error: documentsError } = await supabaseClient
      .from('documents')
      .select('id, metadata')
      .eq('metadata->notebook_id', notebookId)

    diagnostics.vectorStore = {
      documentCount: documents?.length || 0,
      error: documentsError?.message,
      hasDocuments: (documents?.length || 0) > 0
    }

    // Check recent chat history
    const { data: chatHistory, error: chatError } = await supabaseClient
      .from('n8n_chat_histories')
      .select('id, message')
      .eq('session_id', notebookId)
      .order('id', { ascending: false })
      .limit(5)

    diagnostics.chatHistory = {
      messageCount: chatHistory?.length || 0,
      error: chatError?.message,
      recentMessages: chatHistory?.map(msg => ({
        id: msg.id,
        type: msg.message?.type,
        hasError: msg.message?.response_metadata?.error || false
      }))
    }

    // Generate recommendations
    const recommendations: string[] = []

    if (!diagnostics.environment.hasNotebookChatUrl) {
      recommendations.push('Set NOTEBOOK_CHAT_URL in Supabase Edge Function secrets')
    }

    if (!diagnostics.environment.hasNotebookGenerationAuth) {
      recommendations.push('Set NOTEBOOK_GENERATION_AUTH in Supabase Edge Function secrets')
    }

    if (!diagnostics.notebook.exists) {
      recommendations.push('Notebook not found - check the notebook ID')
    }

    if (!diagnostics.sources.hasCompleted) {
      recommendations.push('No completed sources found - wait for source processing to complete')
    }

    if (!diagnostics.vectorStore.hasDocuments) {
      recommendations.push('No documents in vector store - check if sources were properly processed and embedded')
    }

    if (diagnostics.environment.notebookChatUrl && !diagnostics.environment.notebookChatUrl.includes('webhook')) {
      recommendations.push('NOTEBOOK_CHAT_URL should be a valid n8n webhook URL')
    }

    diagnostics.recommendations = recommendations
    diagnostics.overallStatus = recommendations.length === 0 ? 'HEALTHY' : 'ISSUES_FOUND'

    return new Response(
      JSON.stringify(diagnostics, null, 2),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )

  } catch (error) {
    console.error('Error in chat-diagnostics function:', error)
    return new Response(
      JSON.stringify({ 
        error: error.message || 'Diagnostics failed',
        timestamp: new Date().toISOString()
      }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
})