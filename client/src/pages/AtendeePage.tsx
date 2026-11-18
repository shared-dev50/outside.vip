export const AtendeePage: React.FC = () => {
      return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Attendees</h1>

      <div className="overflow-x-auto">
        <table className="table table-zebra w-full">
          <thead>
            <tr>
              <th>
                <input
                  type="text"
                  placeholder="Atendee"
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
                  placeholder="Total spend"
                  className="input input-sm input-bordered w-full"
                />
              </th>
              <th>
                <input
                  type="text"
                  placeholder="Last purchase"
                  className="input input-sm input-bordered w-full"
                />
              </th>
              <th>
                <input
                  type="text"
                  placeholder="SMS opt in"
                  className="input input-sm input-bordered w-full"
                />
              </th>
            </tr>
          </thead>

          <tbody>
            <tr>
              <td>John Doe</td>
              <td>2</td>
              <td>50</td>
              <td>27-Jan-2026</td>
              <td>Yes</td>
            </tr>
            <tr>
              <td>Steve Martin</td>
              <td>1</td>
              <td>50</td>
              <td>02-Feb-2026</td>
              <td>N0</td>
            </tr>
            <tr>
              <td>Kevin Williams</td>
              <td>5</td>
              <td>100</td>
              <td>20-June-2026</td>
              <td>No</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

