// Operações de banco de dados para saldo Namecheap

const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');

class SupabaseBalanceService {
  constructor() {
    this.client = createClient(
      config.SUPABASE_URL,
      config.SUPABASE_SERVICE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );
  }

  async save(balanceData) {
    const { data, error } = await this.client
      .from('namecheap_balance')
      .upsert({
        user_id: config.SUPABASE_USER_ID,
        balance_usd: balanceData.balance_usd,
        balance_brl: balanceData.balance_brl,
        last_synced_at: balanceData.last_synced_at
      }, {
        onConflict: 'user_id'
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async get() {
    const { data, error } = await this.client
      .from('namecheap_balance')
      .select('*')
      .eq('user_id', config.SUPABASE_USER_ID)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }
}

module.exports = new SupabaseBalanceService();
