export const OrdersPage: React.FC = () => {
      return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Orders</h1>

      <div className="overflow-x-auto">
        <table className="table table-zebra w-full">
          <thead>
            <tr>
              <th>
                <input
                  type="text"
                  placeholder="Order #"
                  className="input input-sm input-bordered w-full"
                />
              </th>
              <th>
                <input
                  type="text"
                  placeholder="Date"
                  className="input input-sm input-bordered w-full"
                />
              </th>
              <th>
                <input
                  type="text"
                  placeholder="Event"
                  className="input input-sm input-bordered w-full"
                />
              </th>
              <th>
                <input
                  type="text"
                  placeholder="Tickets"
                  className="input input-sm input-bordered w-full"
                />
              </th>
              <th>
                <input
                  type="text"
                  placeholder="Total"
                  className="input input-sm input-bordered w-full"
                />
              </th>
            </tr>
          </thead>

          <tbody>
            <tr>
              <td>OUT-2026-89412</td>
              <td>27-Feb-2026</td>
              <td>COASTAL SUNDOWNER: Swahili Feast & Sound</td>
              <td>$1</td>
              <td>$20</td>
            </tr>
            <tr>
              <td>OUT-2026-89413</td>
              <td>27-April-2026</td>
              <td>SOL FEST: Under The Baobab Tree</td>
              <td>$5</td>
              <td>$100</td>
            </tr>
            <tr>
              <td>OUT-2026-89414</td>
              <td>26-June-2026</td>
              <td>ALTE CRUISE: Sunset Rooftop Session</td>
              <td>$2</td>
              <td>$40</td>
             </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

